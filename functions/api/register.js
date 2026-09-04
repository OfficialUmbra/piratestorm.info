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

const MAX_ACCOUNTS_PER_IP = 2;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store"
    }
  });
}

/*
 * =====================================================
 * PASSWORT-HASH
 * =====================================================
 *
 * Bestehendes Verfahren bleibt erhalten:
 *
 * PBKDF2
 * SHA-256
 * 100.000 Iterationen
 * zufälliger Salt
 */
async function hashPassword(password, salt) {
  const encoder = new TextEncoder();

  const keyMaterial =
    await crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      "PBKDF2",
      false,
      ["deriveBits"]
    );

  const bits =
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt,
        iterations: 100000,
        hash: "SHA-256"
      },
      keyMaterial,
      256
    );

  return btoa(
    String.fromCharCode(
      ...new Uint8Array(bits)
    )
  );
}

/*
 * =====================================================
 * IP ERMITTELN
 * =====================================================
 *
 * Cloudflare setzt CF-Connecting-IP auf die
 * ursprüngliche Client-IP.
 *
 * Wir speichern diese IP NICHT in D1.
 */
function getClientIp(request) {
  const ip =
    request.headers.get(
      "CF-Connecting-IP"
    );

  if (!ip) {
    return null;
  }

  return ip.trim();
}

/*
 * =====================================================
 * IP-HASH
 * =====================================================
 *
 * HMAC-SHA-256 mit dem geheimen
 * IP_HASH_SECRET aus Cloudflare.
 *
 * Dadurch wird nicht einfach SHA-256(IP)
 * gespeichert.
 */
async function hashIp(ip, secret) {
  const encoder =
    new TextEncoder();

  const key =
    await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      {
        name: "HMAC",
        hash: "SHA-256"
      },
      false,
      ["sign"]
    );

  const signature =
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(ip)
    );

  const bytes =
    new Uint8Array(signature);

  return Array
    .from(bytes)
    .map(
      byte =>
        byte
          .toString(16)
          .padStart(2, "0")
    )
    .join("");
}

/*
 * =====================================================
 * REGISTRIERUNG
 * =====================================================
 */
export async function onRequestPost(context) {
  try {
    const { request, env } =
      context;

    /*
     * Secret muss existieren.
     *
     * Falls die Cloudflare-Konfiguration fehlt,
     * registrieren wir NICHT einfach ohne
     * IP-Schutz weiter.
     */
    if (
      !env.IP_HASH_SECRET ||
      typeof env.IP_HASH_SECRET !== "string" ||
      env.IP_HASH_SECRET.length < 32
    ) {
      console.error(
        "IP_HASH_SECRET fehlt oder ist zu kurz."
      );

      return json({
        success: false,
        error:
          "Die Registrierung ist momentan nicht verfügbar."
      }, 503);
    }

    /*
     * Client-IP holen.
     *
     * Wenn Cloudflare keine IP liefert, wird die
     * Registrierung sicherheitshalber abgelehnt.
     */
    const clientIp =
      getClientIp(request);

    if (!clientIp) {
      console.error(
        "CF-Connecting-IP fehlt."
      );

      return json({
        success: false,
        error:
          "Die Registrierung konnte nicht verifiziert werden."
      }, 400);
    }

    const registrationIpHash =
      await hashIp(
        clientIp,
        env.IP_HASH_SECRET
      );

    /*
     * -------------------------------------------------
     * JSON lesen
     * -------------------------------------------------
     */
    let body;

    try {
      body =
        await request.json();
    } catch {
      return json({
        success: false,
        error:
          "Ungültige Anfrage."
      }, 400);
    }

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

    /*
     * -------------------------------------------------
     * Eingaben prüfen
     * -------------------------------------------------
     */
    if (
      username.length < 2 ||
      username.length > 24
    ) {
      return json({
        success: false,
        error:
          "Spielername muss zwischen 2 und 24 Zeichen lang sein."
      }, 400);
    }

    if (
      password.length < 6 ||
      password.length > 128
    ) {
      return json({
        success: false,
        error:
          "Passwort muss mindestens 6 Zeichen lang sein."
      }, 400);
    }

    if (!SERVERS.includes(server)) {
      return json({
        success: false,
        error:
          "Ungültiger Server."
      }, 400);
    }

    /*
     * -------------------------------------------------
     * Spielername prüfen
     * -------------------------------------------------
     *
     * Derselbe Spielername darf auf unterschiedlichen
     * Servern weiterhin existieren.
     */
    const existing =
      await env.DB
        .prepare(`
          SELECT id
          FROM users
          WHERE LOWER(username) = LOWER(?)
            AND server = ?
          LIMIT 1
        `)
        .bind(
          username,
          server
        )
        .first();

    if (existing) {
      return json({
        success: false,
        error:
          "Dieser Spielername ist auf diesem Server bereits registriert."
      }, 409);
    }

    /*
     * -------------------------------------------------
     * 2-ACCOUNT-IP-LIMIT
     * -------------------------------------------------
     */
    const ipCountResult =
      await env.DB
        .prepare(`
          SELECT COUNT(*) AS count
          FROM users
          WHERE registration_ip_hash = ?
        `)
        .bind(
          registrationIpHash
        )
        .first();

    const accountCount =
      Number(
        ipCountResult?.count || 0
      );

    if (
      accountCount >=
      MAX_ACCOUNTS_PER_IP
    ) {
      return json({
        success: false,
        error:
          "Über diese Internetverbindung wurden bereits zwei Accounts registriert."
      }, 429);
    }

    /*
     * -------------------------------------------------
     * PASSWORT ERSTELLEN
     * -------------------------------------------------
     */
    const salt =
      crypto.getRandomValues(
        new Uint8Array(16)
      );

    const hash =
      await hashPassword(
        password,
        salt
      );

    const saltBase64 =
      btoa(
        String.fromCharCode(
          ...salt
        )
      );

    const passwordHash =
      `pbkdf2$100000$${saltBase64}$${hash}`;

    /*
     * -------------------------------------------------
     * ACCOUNT SPEICHERN
     * -------------------------------------------------
     *
     * Keine echte IP wird gespeichert.
     */
    const result =
      await env.DB
        .prepare(`
          INSERT INTO users (
            username,
            server,
            password_hash,
            registration_ip_hash
          )
          VALUES (?, ?, ?, ?)
        `)
        .bind(
          username,
          server,
          passwordHash,
          registrationIpHash
        )
        .run();

    return json({
      success: true,

      message:
        "Account erfolgreich erstellt.",

      user: {
        id:
          result.meta.last_row_id,

        username,

        server
      }
    }, 201);

  } catch (error) {
    console.error(
      "POST /api/register error:",
      error
    );

    return json({
      success: false,
      error:
        "Bei der Registrierung ist ein Fehler aufgetreten."
    }, 500);
  }
}

/*
 * Andere HTTP-Methoden sind für die
 * Registrierung nicht vorgesehen.
 */
export async function onRequestGet() {
  return json({
    success: false,
    error:
      "Methode nicht erlaubt."
  }, 405);
}

export async function onRequestPut() {
  return json({
    success: false,
    error:
      "Methode nicht erlaubt."
  }, 405);
}

export async function onRequestDelete() {
  return json({
    success: false,
    error:
      "Methode nicht erlaubt."
  }, 405);
}
