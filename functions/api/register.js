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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8"
    }
  });
}

async function hashPassword(password, salt) {
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
      iterations: 210000,
      hash: "SHA-256"
    },
    keyMaterial,
    256
  );

  return btoa(
    String.fromCharCode(...new Uint8Array(bits))
  );
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

    if (username.length < 2 || username.length > 24) {
      return json({
        success: false,
        error: "Spielername muss zwischen 2 und 24 Zeichen lang sein."
      }, 400);
    }

    if (password.length < 6 || password.length > 128) {
      return json({
        success: false,
        error: "Passwort muss mindestens 6 Zeichen lang sein."
      }, 400);
    }

    if (!SERVERS.includes(server)) {
      return json({
        success: false,
        error: "Ungültiger Server."
      }, 400);
    }

    const existing = await env.DB
      .prepare(`
        SELECT id
        FROM users
        WHERE LOWER(username) = LOWER(?)
        AND server = ?
      `)
      .bind(username, server)
      .first();

    if (existing) {
      return json({
        success: false,
        error: "Dieser Spielername ist auf diesem Server bereits registriert."
      }, 409);
    }

    const salt = crypto.getRandomValues(new Uint8Array(16));

    const hash = await hashPassword(password, salt);

    const saltBase64 = btoa(
      String.fromCharCode(...salt)
    );

    const passwordHash =
      `pbkdf2$210000$${saltBase64}$${hash}`;

    const result = await env.DB
      .prepare(`
        INSERT INTO users
        (username, server, password_hash)
        VALUES (?, ?, ?)
      `)
      .bind(username, server, passwordHash)
      .run();

    return json({
      success: true,
      message: "Account erfolgreich erstellt.",
      user: {
        id: result.meta.last_row_id,
        username,
        server
      }
    }, 201);

  } catch (error) {
    console.error(error);

    return json({
      success: false,
      error: "Bei der Registrierung ist ein Fehler aufgetreten."
    }, 500);
  }
}
