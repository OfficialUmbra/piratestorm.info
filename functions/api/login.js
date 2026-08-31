const SERVERS = [
  "Arabien 1",
  "Deutschland 1",
  "Europa 1",
  "Europa 2",
  "Europa 3",
  "Europa 4",
  "Lateinamerika 1",
  "USA 1"
];

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      ...headers
    }
  });
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function verifyPassword(password, storedPassword) {
  const parts = storedPassword.split("$");

  if (parts.length !== 4 || parts[0] !== "pbkdf2") {
    return false;
  }

  const iterations = Number(parts[1]);
  const salt = base64ToBytes(parts[2]);
  const expectedHash = base64ToBytes(parts[3]);

  if (
    !Number.isInteger(iterations) ||
    iterations < 1 ||
    iterations > 100000
  ) {
    return false;
  }

  const encoder = new TextEncoder();

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256"
    },
    keyMaterial,
    256
  );

  const actualHash = new Uint8Array(bits);

  if (actualHash.length !== expectedHash.length) {
    return false;
  }

  let difference = 0;

  for (let i = 0; i < actualHash.length; i++) {
    difference |= actualHash[i] ^ expectedHash[i];
  }

  return difference === 0;
}

function createSessionId() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));

  return Array.from(bytes)
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const body = await request.json();

    const username =
      typeof body.username === "string"
        ? body.username.trim()
        : "";

    const password =
      typeof body.password === "string"
        ? body.password
        : "";

    const server =
      typeof body.server === "string"
        ? body.server.trim()
        : "";

    if (!username || !password || !SERVERS.includes(server)) {
      return json({
        success: false,
        error: "Spielername, Passwort oder Server ist ungültig."
      }, 400);
    }

    const user = await env.DB
      .prepare(`
        SELECT id, username, server, password_hash, avatar_symbol, avatar_color
        FROM users
        WHERE LOWER(username) = LOWER(?)
        AND server = ?
      `)
      .bind(username, server)
      .first();

    if (!user) {
      return json({
        success: false,
        error: "Spielername, Passwort oder Server ist falsch."
      }, 401);
    }

    const passwordCorrect = await verifyPassword(
      password,
      user.password_hash
    );

    if (!passwordCorrect) {
      return json({
        success: false,
        error: "Spielername, Passwort oder Server ist falsch."
      }, 401);
    }

    const sessionId = createSessionId();

    // 30 Tage
    const expiresAt =
      Math.floor(Date.now() / 1000) + (60 * 60 * 24 * 30);

    await env.DB
      .prepare(`
        INSERT INTO sessions
        (id, user_id, expires_at)
        VALUES (?, ?, ?)
      `)
      .bind(sessionId, user.id, expiresAt)
      .run();

    const cookie = [
      `ps_session=${sessionId}`,
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      "Path=/",
      "Max-Age=2592000"
    ].join("; ");

    return json({
      success: true,
      message: "Erfolgreich angemeldet.",
      user: {
        id: user.id,
        username: user.username,
        server: user.server,
        avatar_symbol: user.avatar_symbol,
        avatar_color: user.avatar_color
      }
    }, 200, {
      "Set-Cookie": cookie
    });

  } catch (error) {
    console.error(error);

    return json({
      success: false,
      error: "Beim Login ist ein Fehler aufgetreten."
    }, 500);
  }
}
