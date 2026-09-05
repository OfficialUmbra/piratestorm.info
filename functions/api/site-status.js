/*
 * =====================================================
 * PirateStorm.info
 * Site Presence / Status API
 *
 * GET  /api/site-status
 * POST /api/site-status
 *
 * Liefert:
 *
 * - Besucher online gesamt
 * - Gäste online
 * - eingeloggte Member online
 * - registrierte Accounts gesamt
 *
 * Presence ist unabhängig vom Chat.
 * =====================================================
 */

const ONLINE_TIMEOUT_SECONDS = 5 * 60;


/*
 * =====================================================
 * RESPONSE
 * =====================================================
 */

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=utf-8",

        "Cache-Control":
          "no-store"
      }
    }
  );
}


/*
 * =====================================================
 * COOKIE
 * =====================================================
 */

function getCookie(request, name) {
  const cookie =
    request.headers.get("Cookie") || "";

  for (const part of cookie.split(";")) {
    const [key, ...value] =
      part.trim().split("=");

    if (key === name) {
      return decodeURIComponent(
        value.join("=")
      );
    }
  }

  return null;
}


/*
 * =====================================================
 * CURRENT USER
 * =====================================================
 *
 * WICHTIG:
 *
 * Session liegt in sessions.id.
 * =====================================================
 */

async function getCurrentUser(
  request,
  env
) {
  const sessionId =
    getCookie(
      request,
      "ps_session"
    );

  if (!sessionId) {
    return null;
  }

  const now =
    Math.floor(
      Date.now() / 1000
    );

  return await env.DB.prepare(`
    SELECT
      u.id,
      u.username,
      u.server,
      u.role

    FROM sessions s

    JOIN users u
      ON u.id = s.user_id

    WHERE s.id = ?
      AND s.expires_at > ?

    LIMIT 1
  `)
    .bind(
      sessionId,
      now
    )
    .first();
}


/*
 * =====================================================
 * CLEANUP
 * =====================================================
 */

async function cleanupPresence(env) {
  const cutoff =
    Math.floor(
      Date.now() / 1000
    ) -
    ONLINE_TIMEOUT_SECONDS;

  await env.DB.prepare(`
    DELETE FROM site_presence

    WHERE last_seen < ?
  `)
    .bind(cutoff)
    .run();
}


/*
 * =====================================================
 * VISITOR ID VALIDATION
 * =====================================================
 *
 * visitor_id wird im Browser zufällig erzeugt.
 *
 * Beispiel:
 *
 * ps_7e87e82b_4be4_4a71_8a3f...
 *
 * Wir erlauben nur eine begrenzte Länge und
 * unkritische Zeichen.
 * =====================================================
 */

function normalizeVisitorId(value) {
  if (typeof value !== "string") {
    return null;
  }

  const id =
    value.trim();

  if (
    id.length < 10 ||
    id.length > 100
  ) {
    return null;
  }

  if (
    !/^[a-zA-Z0-9_-]+$/.test(id)
  ) {
    return null;
  }

  return id;
}


/*
 * =====================================================
 * SITE STATISTICS
 * =====================================================
 */

async function getStatistics(env) {
  const now =
    Math.floor(
      Date.now() / 1000
    );

  const cutoff =
    now -
    ONLINE_TIMEOUT_SECONDS;


  /*
   * =================================================
   * ONLINE COUNTS
   * =================================================
   *
   * Member werden nach user_id gezählt.
   *
   * Dadurch wird ein eingeloggter Benutzer nicht
   * mehrfach als Member gezählt, wenn die Seite
   * beispielsweise in mehreren Tabs offen ist.
   *
   * Gäste werden anhand ihrer visitor_id gezählt.
   * =================================================
   */

  const online =
    await env.DB.prepare(`
      SELECT

        COUNT(
          DISTINCT CASE
            WHEN user_id IS NULL
            THEN visitor_id
          END
        ) AS guests,

        COUNT(
          DISTINCT CASE
            WHEN user_id IS NOT NULL
            THEN user_id
          END
        ) AS members

      FROM site_presence

      WHERE last_seen >= ?
    `)
      .bind(cutoff)
      .first();


  /*
   * =================================================
   * REGISTERED USERS
   * =================================================
   */

  const registered =
    await env.DB.prepare(`
      SELECT
        COUNT(*) AS total

      FROM users
    `)
      .first();


  const guests =
    Number(
      online?.guests || 0
    );

  const members =
    Number(
      online?.members || 0
    );

  const registeredUsers =
    Number(
      registered?.total || 0
    );


  return {
    online:
      guests + members,

    guests,

    members,

    registered:
      registeredUsers
  };
}


/*
 * =====================================================
 * GET
 * =====================================================
 *
 * GET /api/site-status
 *
 * Dieser Request verändert keine Presence.
 *
 * Er liefert nur den aktuellen Stand.
 * =====================================================
 */

export async function onRequestGet(
  context
) {
  try {
    const { env } =
      context;

    await cleanupPresence(
      env
    );

    const stats =
      await getStatistics(
        env
      );

    return json({
      ok: true,

      online:
        stats.online,

      guests:
        stats.guests,

      members:
        stats.members,

      registered:
        stats.registered,

      timeout_seconds:
        ONLINE_TIMEOUT_SECONDS
    });

  } catch (error) {
    console.error(
      "GET /api/site-status error:",
      error
    );

    return json({
      ok: false,

      error:
        "Der Seitenstatus konnte nicht geladen werden."
    }, 500);
  }
}


/*
 * =====================================================
 * POST
 * =====================================================
 *
 * HEARTBEAT
 *
 * Body:
 *
 * {
 *   "visitor_id": "ps_..."
 * }
 *
 *
 * Nicht eingeloggt:
 *
 * visitor_id + user_id NULL
 *
 *
 * Eingeloggt:
 *
 * visitor_id + echte user_id
 *
 *
 * Das Frontend sendet später etwa alle
 * 30 Sekunden einen Heartbeat.
 * =====================================================
 */

export async function onRequestPost(
  context
) {
  try {
    const {
      request,
      env
    } = context;

    let body;

    try {
      body =
        await request.json();

    } catch {
      return json({
        ok: false,

        error:
          "Ungültige Anfrage."
      }, 400);
    }


    /*
     * =================================================
     * VISITOR ID
     * =================================================
     */

    const visitorId =
      normalizeVisitorId(
        body.visitor_id
      );

    if (!visitorId) {
      return json({
        ok: false,

        error:
          "Ungültige Besucher-ID."
      }, 400);
    }


    /*
     * =================================================
     * LOGIN STATUS
     * =================================================
     */

    const user =
      await getCurrentUser(
        request,
        env
      );

    const userId =
      user
        ? user.id
        : null;

    const now =
      Math.floor(
        Date.now() / 1000
      );


    /*
     * =================================================
     * PRESENCE UPSERT
     * =================================================
     */

    await env.DB.prepare(`
      INSERT INTO site_presence (
        visitor_id,
        user_id,
        last_seen,
        created_at
      )

      VALUES (?, ?, ?, ?)

      ON CONFLICT(visitor_id)

      DO UPDATE SET
        user_id =
          excluded.user_id,

        last_seen =
          excluded.last_seen
    `)
      .bind(
        visitorId,
        userId,
        now,
        now
      )
      .run();


    /*
     * =================================================
     * CLEANUP
     * =================================================
     */

    await cleanupPresence(
      env
    );


    /*
     * =================================================
     * CURRENT STATISTICS
     * =================================================
     */

    const stats =
      await getStatistics(
        env
      );


    return json({
      ok: true,

      presence: {
        online:
          true,

        authenticated:
          Boolean(user),

        user_id:
          userId,

        username:
          user
            ? user.username
            : null,

        last_seen:
          now
      },

      online:
        stats.online,

      guests:
        stats.guests,

      members:
        stats.members,

      registered:
        stats.registered,

      timeout_seconds:
        ONLINE_TIMEOUT_SECONDS
    });

  } catch (error) {
    console.error(
      "POST /api/site-status error:",
      error
    );

    return json({
      ok: false,

      error:
        "Der Online-Status konnte nicht aktualisiert werden."
    }, 500);
  }
}


/*
 * =====================================================
 * DELETE
 * =====================================================
 *
 * Optional:
 *
 * Das Frontend kann beim Logout die eigene Presence
 * sofort entfernen.
 *
 * Body:
 *
 * {
 *   "visitor_id": "ps_..."
 * }
 *
 * Wir verlassen uns trotzdem hauptsächlich auf den
 * 5-Minuten-Timeout, da Browser beim Schließen nicht
 * garantiert noch einen Request senden.
 * =====================================================
 */

export async function onRequestDelete(
  context
) {
  try {
    const {
      request,
      env
    } = context;

    let body;

    try {
      body =
        await request.json();

    } catch {
      return json({
        ok: false,

        error:
          "Ungültige Anfrage."
      }, 400);
    }

    const visitorId =
      normalizeVisitorId(
        body.visitor_id
      );

    if (!visitorId) {
      return json({
        ok: false,

        error:
          "Ungültige Besucher-ID."
      }, 400);
    }

    await env.DB.prepare(`
      DELETE FROM site_presence

      WHERE visitor_id = ?
    `)
      .bind(
        visitorId
      )
      .run();

    const stats =
      await getStatistics(
        env
      );

    return json({
      ok: true,

      removed:
        true,

      online:
        stats.online,

      guests:
        stats.guests,

      members:
        stats.members,

      registered:
        stats.registered
    });

  } catch (error) {
    console.error(
      "DELETE /api/site-status error:",
      error
    );

    return json({
      ok: false,

      error:
        "Der Online-Status konnte nicht entfernt werden."
    }, 500);
  }
}


/*
 * =====================================================
 * PUT
 * =====================================================
 */

export async function onRequestPut() {
  return json({
    ok: false,

    error:
      "Diese Methode wird nicht unterstützt."
  }, 405);
}
