import { TelegramClient } from "@mtcute/node";
import { SqliteStorage } from "@mtcute/node";
import { db, telegramAccountsTable, pendingSessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { mkdirSync, existsSync } from "fs";
import path from "path";

const API_ID = 32140582;
const API_HASH = "e9597b6e5e64a9d093071e20d0545f3f";

const SESSIONS_DIR = path.resolve(process.cwd(), ".tg-sessions");

if (!existsSync(SESSIONS_DIR)) {
  mkdirSync(SESSIONS_DIR, { recursive: true });
}

function sessionPath(phone: string): string {
  const safe = phone.replace(/[^a-z0-9]/gi, "_");
  return path.join(SESSIONS_DIR, `${safe}.db`);
}

function pendingSessionPath(sessionId: string): string {
  return path.join(SESSIONS_DIR, `pending_${sessionId}.db`);
}

export function createClient(storagePath: string): TelegramClient {
  return new TelegramClient({
    apiId: API_ID,
    apiHash: API_HASH,
    storage: new SqliteStorage(storagePath),
    logLevel: 0,
  });
}

export async function sendCode(phone: string): Promise<{ phoneCodeHash: string; sessionId: string }> {
  const sessionId = randomUUID();
  const storagePath = pendingSessionPath(sessionId);
  const client = createClient(storagePath);

  await client.connect();
  const result = await client.sendCode({ phone });

  await db.insert(pendingSessionsTable).values({
    sessionId,
    phone,
    phoneCodeHash: result.phoneCodeHash,
    sessionData: storagePath,
  }).onConflictDoUpdate({
    target: pendingSessionsTable.sessionId,
    set: { phoneCodeHash: result.phoneCodeHash, sessionData: storagePath },
  });

  await client.disconnect();
  return { phoneCodeHash: result.phoneCodeHash, sessionId };
}

export async function signIn(
  phone: string,
  code: string,
  phoneCodeHash: string,
  sessionId: string,
  password?: string | null,
): Promise<{ id: string; firstName: string; lastName: string | null; username: string | null; has2fa: boolean }> {
  const pending = await db.select().from(pendingSessionsTable).where(eq(pendingSessionsTable.sessionId, sessionId)).limit(1);
  if (!pending.length) throw new Error("Session not found or expired");

  const storagePath = pending[0].sessionData;
  const client = createClient(storagePath);
  await client.connect();

  let user;
  try {
    user = await client.signIn({ phone, code, phoneCodeHash });
  } catch (e: any) {
    const msg = e?.message ?? "";
    if (msg.includes("SESSION_PASSWORD_NEEDED") || msg.includes("2FA")) {
      if (!password) {
        await client.disconnect();
        throw new Error("2FA_REQUIRED");
      }
      user = await client.checkPassword(password);
    } else {
      await client.disconnect();
      throw e;
    }
  }

  let has2fa = false;
  try {
    const pwInfo = await client.getPasswordInfo();
    has2fa = pwInfo.hasPassword;
  } catch {}

  const finalPath = sessionPath(phone);
  const { renameSync, existsSync: exists } = await import("fs");
  if (exists(storagePath)) {
    try { renameSync(storagePath, finalPath); } catch { /* keep storagePath */ }
  }

  const userId = BigInt(user.id);
  await db.insert(telegramAccountsTable).values({
    phone,
    userId,
    firstName: user.firstName ?? "",
    lastName: user.lastName ?? null,
    username: user.username ?? null,
    sessionData: finalPath,
    has2fa,
  }).onConflictDoUpdate({
    target: telegramAccountsTable.phone,
    set: {
      userId,
      firstName: user.firstName ?? "",
      lastName: user.lastName ?? null,
      username: user.username ?? null,
      sessionData: finalPath,
      has2fa,
      updatedAt: new Date(),
    },
  });

  await db.delete(pendingSessionsTable).where(eq(pendingSessionsTable.sessionId, sessionId));
  await client.disconnect();

  return {
    id: user.id.toString(),
    firstName: user.firstName ?? "",
    lastName: user.lastName ?? null,
    username: user.username ?? null,
    has2fa,
  };
}

export async function getAccountClient(phone: string): Promise<TelegramClient> {
  const accounts = await db.select().from(telegramAccountsTable).where(eq(telegramAccountsTable.phone, phone)).limit(1);
  if (!accounts.length) throw new Error("Account not found");

  const storagePath = accounts[0].sessionData || sessionPath(phone);
  const client = createClient(storagePath);
  await client.connect();
  return client;
}

export async function getAllAccounts() {
  return db.select().from(telegramAccountsTable);
}

export async function removeAccount(phone: string): Promise<void> {
  const accounts = await db.select().from(telegramAccountsTable).where(eq(telegramAccountsTable.phone, phone)).limit(1);
  if (accounts.length) {
    const storagePath = accounts[0].sessionData;
    try {
      const { unlinkSync, existsSync: exists } = await import("fs");
      if (storagePath && exists(storagePath)) unlinkSync(storagePath);
    } catch {}
  }
  await db.delete(telegramAccountsTable).where(eq(telegramAccountsTable.phone, phone));
}
