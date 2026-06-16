import { Router } from "express";
import {
  SendCodeBody,
  SignInBody,
  Disable2faBody,
  TerminateSessionBody,
  ChangeEmailBody,
  VerifyEmailBody,
} from "@workspace/api-zod";
import {
  sendCode,
  signIn,
  getAccountClient,
  getAllAccounts,
  removeAccount,
} from "../lib/telegram-manager";
import { db, telegramAccountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

router.post("/telegram/send-code", async (req, res) => {
  const body = SendCodeBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid request" });

  try {
    const result = await sendCode(body.data.phone);
    res.json(result);
  } catch (e: any) {
    req.log.error({ err: e }, "send-code error");
    res.status(500).json({ error: e.message });
  }
});

router.post("/telegram/sign-in", async (req, res) => {
  const body = SignInBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid request" });

  try {
    const user = await signIn(
      body.data.phone,
      body.data.code,
      body.data.phoneCodeHash,
      body.data.sessionId,
      body.data.password ?? null,
    );
    res.json({ phone: body.data.phone, ...user });
  } catch (e: any) {
    req.log.error({ err: e }, "sign-in error");
    if (e.message === "2FA_REQUIRED") {
      return res.status(422).json({ error: "2FA_REQUIRED" });
    }
    res.status(500).json({ error: e.message });
  }
});

router.get("/telegram/accounts", async (req, res) => {
  try {
    const accounts = await getAllAccounts();
    res.json(
      accounts.map((a) => ({
        phone: a.phone,
        id: a.userId.toString(),
        firstName: a.firstName,
        lastName: a.lastName ?? null,
        username: a.username ?? null,
        has2fa: a.has2fa ?? false,
      })),
    );
  } catch (e: any) {
    req.log.error({ err: e }, "list-accounts error");
    res.status(500).json({ error: e.message });
  }
});

router.get("/telegram/accounts/:phone", async (req, res) => {
  try {
    const accounts = await db
      .select()
      .from(telegramAccountsTable)
      .where(eq(telegramAccountsTable.phone, decodeURIComponent(req.params.phone)))
      .limit(1);
    if (!accounts.length) return res.status(404).json({ error: "Account not found" });
    const a = accounts[0];
    res.json({
      phone: a.phone,
      id: a.userId.toString(),
      firstName: a.firstName,
      lastName: a.lastName ?? null,
      username: a.username ?? null,
      has2fa: a.has2fa ?? false,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/telegram/accounts/:phone", async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    await removeAccount(phone);
    res.json({ success: true, message: "Account removed" });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/telegram/accounts/:phone/disable-2fa", async (req, res) => {
  const body = Disable2faBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid request" });

  const phone = decodeURIComponent(req.params.phone);
  let client;
  try {
    client = await getAccountClient(phone);
    await client.updatePassword(body.data.password, null);
    await db
      .update(telegramAccountsTable)
      .set({ has2fa: false, updatedAt: new Date() })
      .where(eq(telegramAccountsTable.phone, phone));
    res.json({ success: true, message: "2FA disabled successfully" });
  } catch (e: any) {
    req.log.error({ err: e }, "disable-2fa error");
    res.status(500).json({ error: e.message });
  } finally {
    if (client) await client.close().catch(() => {});
  }
});

router.get("/telegram/accounts/:phone/login-code", async (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  let client;
  try {
    client = await getAccountClient(phone);
    const messages = await client.getMessages("777000", { limit: 5 });
    let found = false;
    let code: string | null = null;
    let from: string | null = null;
    let date: string | null = null;

    for (const msg of messages) {
      if (msg.text) {
        const match = msg.text.match(/(\d{5,6})/);
        if (match) {
          found = true;
          code = match[1];
          from = "Telegram";
          date = new Date(msg.date * 1000).toISOString();
          break;
        }
      }
    }

    res.json({ found, code, from, date });
  } catch (e: any) {
    req.log.error({ err: e }, "get-login-code error");
    res.status(500).json({ error: e.message });
  } finally {
    if (client) await client.close().catch(() => {});
  }
});

router.get("/telegram/accounts/:phone/sessions", async (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  let client;
  try {
    client = await getAccountClient(phone);
    const auths = await client.getAuthorizations();
    res.json(
      auths.map((a: any) => ({
        hash: a.hash?.toString() ?? "0",
        deviceModel: a.deviceModel ?? "Unknown",
        platform: a.platform ?? "Unknown",
        appName: a.appName ?? "Unknown",
        dateCreated: new Date((a.dateCreated ?? 0) * 1000).toISOString(),
        dateActive: new Date((a.dateActive ?? 0) * 1000).toISOString(),
        ip: a.ip ?? "Unknown",
        country: a.country ?? "Unknown",
        current: a.current ?? false,
      })),
    );
  } catch (e: any) {
    req.log.error({ err: e }, "get-sessions error");
    res.status(500).json({ error: e.message });
  } finally {
    if (client) await client.close().catch(() => {});
  }
});

router.post("/telegram/accounts/:phone/terminate-session", async (req, res) => {
  const body = TerminateSessionBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid request" });

  const phone = decodeURIComponent(req.params.phone);
  let client;
  try {
    client = await getAccountClient(phone);
    await client.terminateAuthorization(BigInt(body.data.hash));
    res.json({ success: true, message: "Session terminated" });
  } catch (e: any) {
    req.log.error({ err: e }, "terminate-session error");
    res.status(500).json({ error: e.message });
  } finally {
    if (client) await client.close().catch(() => {});
  }
});

router.post("/telegram/accounts/:phone/terminate-all-sessions", async (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  let client;
  try {
    client = await getAccountClient(phone);
    await client.terminateAllOtherSessions();
    res.json({ success: true, message: "All other sessions terminated" });
  } catch (e: any) {
    req.log.error({ err: e }, "terminate-all-sessions error");
    res.status(500).json({ error: e.message });
  } finally {
    if (client) await client.close().catch(() => {});
  }
});

router.post("/telegram/accounts/:phone/change-email", async (req, res) => {
  const body = ChangeEmailBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid request" });

  const phone = decodeURIComponent(req.params.phone);
  let client;
  try {
    client = await getAccountClient(phone);
    await client.changeEmail(body.data.email);
    res.json({ success: true, message: "Verification code sent to email" });
  } catch (e: any) {
    req.log.error({ err: e }, "change-email error");
    res.status(500).json({ error: e.message });
  } finally {
    if (client) await client.close().catch(() => {});
  }
});

router.post("/telegram/accounts/:phone/verify-email", async (req, res) => {
  const body = VerifyEmailBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid request" });

  const phone = decodeURIComponent(req.params.phone);
  let client;
  try {
    client = await getAccountClient(phone);
    await client.verifyEmail(body.data.email, body.data.code);
    res.json({ success: true, message: "Email changed successfully" });
  } catch (e: any) {
    req.log.error({ err: e }, "verify-email error");
    res.status(500).json({ error: e.message });
  } finally {
    if (client) await client.close().catch(() => {});
  }
});

router.post("/telegram/accounts/:phone/send-message", async (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  const { username, message } = req.body;
  if (!username || !message) return res.status(400).json({ error: "username and message required" });
  let client;
  try {
    client = await getAccountClient(phone);
    await client.sendText(username, message);
    res.json({ success: true, message: "Message sent" });
  } catch (e: any) {
    req.log.error({ err: e }, "send-message error");
    res.status(500).json({ error: e.message });
  } finally {
    if (client) await client.close().catch(() => {});
  }
});

router.post("/telegram/accounts/:phone/join-channel", async (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  const { channel } = req.body;
  if (!channel) return res.status(400).json({ error: "channel required" });
  let client;
  try {
    client = await getAccountClient(phone);
    await client.joinChat(channel);
    res.json({ success: true, message: `Joined ${channel}` });
  } catch (e: any) {
    req.log.error({ err: e }, "join-channel error");
    res.status(500).json({ error: e.message });
  } finally {
    if (client) await client.close().catch(() => {});
  }
});

router.post("/telegram/join-all", async (req, res) => {
  const { channel } = req.body;
  if (!channel) return res.status(400).json({ error: "channel required" });
  const accounts = await getAllAccounts();
  const results: Array<{ phone: string; success: boolean; error?: string }> = [];
  for (const acc of accounts) {
    let client;
    try {
      client = await getAccountClient(acc.phone);
      await client.joinChat(channel);
      results.push({ phone: acc.phone, success: true });
    } catch (e: any) {
      results.push({ phone: acc.phone, success: false, error: e.message });
    } finally {
      if (client) await client.close().catch(() => {});
    }
  }
  res.json({ results });
});

export default router;
