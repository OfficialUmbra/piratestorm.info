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
  const cookie =
    request.headers.get("Cookie") || "";

  for (
    const part
    of cookie.split(";")
  ) {
    const [
      key,
      ...value
    ] =
      part
        .trim()
        .split("=");

    if (
      key === name
    ) {
      return decodeURIComponent(
        value.join("=")
      );
    }
  }

  return null;
}

async function getCurrentUser(
  request,
  env
) {
  const token =
    getCookie(
      request,
      "ps_session"
    );

  if (!token) {
    return null;
  }

  const now =
    Math.floor(
      Date.now() / 1000
    );

  return await env.DB.prepare(`
    SELECT
      users.id,
      users.username,
      users.server,
      users.role

    FROM sessions

    JOIN users
      ON users.id =
        sessions.user_id

    WHERE sessions.id = ?
      AND sessions.expires_at > ?

    LIMIT 1
  `)
    .bind(
      token,
      now
    )
    .first();
}

function isAdmin(user) {
  return Boolean(
    user &&
    user.role ===
      "admin"
  );
}

function isModerator(user) {
  return Boolean(
    user &&
    user.role ===
      "moderator"
  );
}

function canModerate(user) {
  return Boolean(
    user &&
    (
      isAdmin(user) ||
      isModerator(user)
    )
  );
}

function safeParseDetails(
  value
) {
  if (!value) {
    return null;
  }

  if (
    typeof value !==
    "string"
  ) {
    return value;
  }

  try {
    return JSON.parse(
      value
    );

  } catch {
    return value;
  }
}

export async function onRequestGet(
  context
) {
  try {
    const {
      request,
      env
    } = context;

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

    if (
      !canModerate(
        user
      )
    ) {
      return json({
        ok: false,

        error:
          "Nur Administratoren und Moderatoren dürfen das Moderationsprotokoll einsehen."
      }, 403);
    }

    const url =
      new URL(
        request.url
      );

    const requestedLimit =
      Number(
        url.searchParams.get(
          "limit"
        ) ||
        100
      );

    const limit =
      Number.isFinite(
        requestedLimit
      )
        ? Math.max(
            1,
            Math.min(
              Math.floor(
                requestedLimit
              ),
              250
            )
          )
        : 100;

    const actionRaw =
      url.searchParams.get(
        "action"
      );

    const action =
      typeof actionRaw ===
        "string"
        ? actionRaw.trim()
        : "";

    const userIdRaw =
      url.searchParams.get(
        "user_id"
      );

    let targetUserId =
      null;

    if (
      userIdRaw !== null &&
      userIdRaw !== ""
    ) {
      const parsed =
        Number(
          userIdRaw
        );

      if (
        !Number.isInteger(
          parsed
        ) ||
        parsed <= 0
      ) {
        return json({
          ok: false,

          error:
            "Ungültige Spieler-ID."
        }, 400);
      }

      targetUserId =
        parsed;
    }

    let query = `
      SELECT
        log.id,
        log.admin_id,
        log.target_user_id,
        log.action,
        log.details,
        log.created_at,

        admin.username
          AS admin_username,

        admin.server
          AS admin_server,

        admin.role
          AS admin_role,

        target.username
          AS target_username,

        target.server
          AS target_server,

        target.role
          AS target_role

      FROM chat_moderation_log log

      JOIN users admin
        ON admin.id =
          log.admin_id

      LEFT JOIN users target
        ON target.id =
          log.target_user_id

      WHERE 1 = 1
    `;

    const bindings = [];

    if (
      action
    ) {
      query += `
        AND log.action = ?
      `;

      bindings.push(
        action
      );
    }

    if (
      targetUserId !==
      null
    ) {
      query += `
        AND log.target_user_id = ?
      `;

      bindings.push(
        targetUserId
      );
    }

    if (
      isModerator(
        user
      )
    ) {
      query += `
        AND (
          target.role IS NULL
          OR target.role = 'user'
        )
      `;

    } else {
      query += `
        AND (
          target.role IS NULL
          OR target.role != 'admin'
        )
      `;
    }

    query += `
      ORDER BY
        log.created_at DESC,
        log.id DESC

      LIMIT ?
    `;

    bindings.push(
      limit
    );

    const result =
      await env.DB
        .prepare(
          query
        )
        .bind(
          ...bindings
        )
        .all();

    const entries =
      (
        result.results ||
        []
      ).map(
        entry => ({
          id:
            entry.id,

          action:
            entry.action,

          created_at:
            entry.created_at,

          admin: {
            id:
              entry.admin_id,

            username:
              entry.admin_username,

            server:
              entry.admin_server,

            role:
              entry.admin_role,

            is_admin:
              entry.admin_role ===
              "admin",

            is_moderator:
              entry.admin_role ===
              "moderator"
          },

          target:
            entry.target_user_id
              ? {
                  id:
                    entry.target_user_id,

                  username:
                    entry.target_username,

                  server:
                    entry.target_server,

                  role:
                    entry.target_role,

                  is_admin:
                    entry.target_role ===
                    "admin",

                  is_moderator:
                    entry.target_role ===
                    "moderator"
                }
              : null,

          target_username:
            entry.target_username ||
            null,

          details:
            safeParseDetails(
              entry.details
            )
        })
      );

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
          isAdmin(
            user
          ),

        is_moderator:
          isModerator(
            user
          )
      },

      filters: {
        action:
          action ||
          null,

        user_id:
          targetUserId,

        limit
      },

      count:
        entries.length,

      entries
    });

  } catch (error) {
    console.error(
      "GET /api/chat/modlog error:",
      error
    );

    return json({
      ok: false,

      error:
        "Das Moderationsprotokoll konnte nicht geladen werden."
    }, 500);
  }
}

export async function onRequestPost() {
  return json({
    ok: false,

    error:
      "Das Moderationsprotokoll kann nicht direkt erstellt werden."
  }, 405);
}

export async function onRequestPut() {
  return json({
    ok: false,

    error:
      "Das Moderationsprotokoll kann nicht direkt bearbeitet werden."
  }, 405);
}

export async function onRequestDelete() {
  return json({
    ok: false,

    error:
      "Das Moderationsprotokoll kann nicht direkt gelöscht werden."
  }, 405);
}
