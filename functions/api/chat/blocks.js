function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";

  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");

    if (key === name) {
      return decodeURIComponent(value.join("="));
    }
  }

  return null;
}

async function getCurrentUser(request, env) {
  const token = getCookie(request, "ps_session");

  if (!token) {
    return null;
  }

  return await env.DB.prepare(`
    SELECT
      users.id,
      users.username,
      users.server,
      users.role
    FROM sessions
    JOIN users
      ON users.id = sessions.user_id
    WHERE sessions.id = ?
      AND sessions.expires_at > ?
    LIMIT 1
  `)
    .bind(
      token,
      Math.floor(Date.now() / 1000)
    )
    .first();
}

function isAdmin(user) {
  return Boolean(
    user &&
    user.role === "admin"
  );
}

async function getUserById(env, userId) {
  return await env.DB.prepare(`
    SELECT
      id,
      username,
      server,
      role
    FROM users
    WHERE id = ?
    LIMIT 1
  `)
    .bind(userId)
    .first();
}

/*
 * =====================================================
 * GET
 * =====================================================
 *
 * Eigene Blockierliste laden.
 */
export async function onRequestGet(context) {
  try {
    const { request, env } = context;

    const user =
      await getCurrentUser(
        request,
        env
      );

    if (!user) {
      return json({
        ok: false,
        error:
          "Du musst eingeloggt sein."
      }, 401);
    }

    const result =
      await env.DB.prepare(`
        SELECT
          cb.id,
          cb.blocked_id,
          cb.created_at,

          u.username,
          u.server,
          u.role

        FROM chat_blocks cb

        JOIN users u
          ON u.id = cb.blocked_id

        WHERE cb.blocker_id = ?

        ORDER BY
          LOWER(u.username) ASC
      `)
        .bind(user.id)
        .all();

    /*
     * Zusätzliche Absicherung:
     * Admins sollen niemals als blockierte Spieler
     * an den Client geliefert werden.
     */
    const blocks =
      (result.results || [])
        .filter(
          row =>
            row.role !== "admin"
        )
        .map(row => ({
          id:
            row.id,

          created_at:
            row.created_at,

          user: {
            id:
              row.blocked_id,

            username:
              row.username,

            server:
              row.server,

            role:
              row.role,

            is_admin:
              false
          }
        }));

    return json({
      ok: true,

      current_user: {
        id:
          user.id,

        username:
          user.username,

        server:
          user.server,

        role:
          user.role,

        is_admin:
          isAdmin(user)
      },

      blocks
    });

  } catch (error) {
    console.error(
      "GET /api/chat/blocks error:",
      error
    );

    return json({
      ok: false,
      error:
        "Die Blockierliste konnte nicht geladen werden."
    }, 500);
  }
}

/*
 * =====================================================
 * POST
 * =====================================================
 *
 * Spieler blockieren.
 *
 * Erwartet:
 *
 * {
 *   "user_id": 123
 * }
 */
export async function onRequestPost(context) {
  try {
    const { request, env } = context;

    const user =
      await getCurrentUser(
        request,
        env
      );

    if (!user) {
      return json({
        ok: false,
        error:
          "Du musst eingeloggt sein."
      }, 401);
    }

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

    const blockedUserId =
      Number(body.user_id);

    if (
      !Number.isInteger(
        blockedUserId
      ) ||
      blockedUserId <= 0
    ) {
      return json({
        ok: false,
        error:
          "Ungültige Spieler-ID."
      }, 400);
    }

    /*
     * Man kann sich nicht selbst blockieren.
     */
    if (
      blockedUserId ===
      user.id
    ) {
      return json({
        ok: false,
        error:
          "Du kannst dich nicht selbst blockieren."
      }, 400);
    }

    const target =
      await getUserById(
        env,
        blockedUserId
      );

    if (!target) {
      return json({
        ok: false,
        error:
          "Spieler wurde nicht gefunden."
      }, 404);
    }

    /*
     * =================================================
     * ADMIN-IMMUNITÄT
     * =================================================
     *
     * Ein Account mit role = admin kann niemals
     * blockiert werden.
     *
     * Die Prüfung erfolgt ausschließlich über
     * die Rolle und NICHT über den Spielernamen.
     */
    if (isAdmin(target)) {
      return json({
        ok: false,
        error:
          "Der Administrator kann nicht blockiert werden."
      }, 403);
    }

    /*
     * Persönliche Blocks sollen nur zwischen Spielern
     * desselben Pirate-Storm-Servers möglich sein.
     */
    if (
      target.server !==
      user.server
    ) {
      return json({
        ok: false,
        error:
          "Du kannst nur Spieler deines eigenen Servers blockieren."
      }, 403);
    }

    const existing =
      await env.DB.prepare(`
        SELECT id
        FROM chat_blocks
        WHERE blocker_id = ?
          AND blocked_id = ?
        LIMIT 1
      `)
        .bind(
          user.id,
          target.id
        )
        .first();

    if (existing) {
      return json({
        ok: true,

        already_blocked:
          true,

        block: {
          id:
            existing.id,

          user: {
            id:
              target.id,

            username:
              target.username,

            server:
              target.server,

            role:
              target.role,

            is_admin:
              false
          }
        },

        message:
          `${target.username} ist bereits blockiert.`
      });
    }

    const now =
      Math.floor(
        Date.now() / 1000
      );

    const result =
      await env.DB.prepare(`
        INSERT INTO chat_blocks (
          blocker_id,
          blocked_id,
          created_at
        )
        VALUES (?, ?, ?)
      `)
        .bind(
          user.id,
          target.id,
          now
        )
        .run();

    return json({
      ok: true,

      already_blocked:
        false,

      block: {
        id:
          result.meta.last_row_id,

        created_at:
          now,

        user: {
          id:
            target.id,

          username:
            target.username,

          server:
            target.server,

          role:
            target.role,

          is_admin:
            false
        }
      },

      message:
        `${target.username} wurde blockiert.`
    }, 201);

  } catch (error) {
    console.error(
      "POST /api/chat/blocks error:",
      error
    );

    return json({
      ok: false,
      error:
        "Der Spieler konnte nicht blockiert werden."
    }, 500);
  }
}

/*
 * =====================================================
 * DELETE
 * =====================================================
 *
 * Blockierung aufheben.
 *
 * Unterstützt:
 *
 * /api/chat/blocks?user_id=123
 *
 * oder JSON:
 *
 * {
 *   "user_id": 123
 * }
 */
export async function onRequestDelete(context) {
  try {
    const { request, env } = context;

    const user =
      await getCurrentUser(
        request,
        env
      );

    if (!user) {
      return json({
        ok: false,
        error:
          "Du musst eingeloggt sein."
      }, 401);
    }

    const url =
      new URL(request.url);

    let blockedUserId =
      Number(
        url.searchParams.get(
          "user_id"
        )
      );

    /*
     * Falls keine ID in der URL steht,
     * versuchen wir den JSON-Body.
     */
    if (
      !Number.isInteger(
        blockedUserId
      ) ||
      blockedUserId <= 0
    ) {
      try {
        const body =
          await request.json();

        blockedUserId =
          Number(body.user_id);
      } catch {
        // Kein JSON-Body vorhanden.
      }
    }

    if (
      !Number.isInteger(
        blockedUserId
      ) ||
      blockedUserId <= 0
    ) {
      return json({
        ok: false,
        error:
          "Ungültige Spieler-ID."
      }, 400);
    }

    const existing =
      await env.DB.prepare(`
        SELECT
          cb.id,
          cb.blocked_id,

          u.username,
          u.role

        FROM chat_blocks cb

        JOIN users u
          ON u.id =
            cb.blocked_id

        WHERE cb.blocker_id = ?
          AND cb.blocked_id = ?

        LIMIT 1
      `)
        .bind(
          user.id,
          blockedUserId
        )
        .first();

    if (!existing) {
      return json({
        ok: false,
        error:
          "Dieser Spieler ist nicht blockiert."
      }, 404);
    }

    /*
     * Sollte durch alte/manipulierte Daten ein Admin
     * in chat_blocks stehen, wird der Datensatz zwar
     * entfernt, aber niemals als gültige Blockierung
     * behandelt.
     */
    await env.DB.prepare(`
      DELETE FROM chat_blocks
      WHERE blocker_id = ?
        AND blocked_id = ?
    `)
      .bind(
        user.id,
        blockedUserId
      )
      .run();

    return json({
      ok: true,

      user_id:
        blockedUserId,

      message:
        existing.role === "admin"
          ? "Ungültige Admin-Blockierung wurde entfernt."
          : `${existing.username} wurde entblockiert.`
    });

  } catch (error) {
    console.error(
      "DELETE /api/chat/blocks error:",
      error
    );

    return json({
      ok: false,
      error:
        "Die Blockierung konnte nicht aufgehoben werden."
    }, 500);
  }
}
