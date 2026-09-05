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
      token,
      now
    )
    .first();
}

async function addModerationLog(
  env,
  adminId,
  targetId,
  action,
  details
) {
  try {
    await env.DB.prepare(`
      INSERT INTO chat_moderation_log (
        admin_id,
        target_user_id,
        action,
        details,
        created_at
      )

      VALUES (?, ?, ?, ?, ?)
    `)
      .bind(
        adminId,
        targetId,
        action,
        JSON.stringify(
          details || {}
        ),
        Math.floor(
          Date.now() / 1000
        )
      )
      .run();

  } catch (error) {
    console.error(
      "Role moderation log error:",
      error
    );
  }
}

export async function onRequestPut(
  context
) {
  try {
    const {
      request,
      env
    } = context;

    const admin =
      await getCurrentUser(
        request,
        env
      );

    if (!admin) {
      return json({
        ok: false,

        error:
          "Du musst eingeloggt sein."
      }, 401);
    }

    if (
      admin.role !==
      "admin"
    ) {
      return json({
        ok: false,

        error:
          "Nur Administratoren dürfen Moderatorrollen vergeben oder entfernen."
      }, 403);
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

    const userId =
      Number(
        body.user_id ||
        body.target_user_id
      );

    const role =
      typeof body.role ===
        "string"
        ? body.role
            .trim()
            .toLowerCase()
        : "";

    if (
      !Number.isInteger(
        userId
      ) ||
      userId <= 0
    ) {
      return json({
        ok: false,

        error:
          "Ungültiger Spieler."
      }, 400);
    }

    if (
      ![
        "user",
        "moderator"
      ].includes(
        role
      )
    ) {
      return json({
        ok: false,

        error:
          "Es kann nur zwischen user und moderator gewechselt werden."
      }, 400);
    }

    if (
      Number(userId) ===
      Number(admin.id)
    ) {
      return json({
        ok: false,

        error:
          "Deine eigene Adminrolle kann hier nicht geändert werden."
      }, 403);
    }

    const target =
      await env.DB.prepare(`
        SELECT
          id,
          username,
          server,
          role

        FROM users

        WHERE id = ?

        LIMIT 1
      `)
        .bind(
          userId
        )
        .first();

    if (!target) {
      return json({
        ok: false,

        error:
          "Spieler wurde nicht gefunden."
      }, 404);
    }

    if (
      target.role ===
      "admin"
    ) {
      return json({
        ok: false,

        error:
          "Die Adminrolle kann über den Chat nicht geändert werden."
      }, 403);
    }

    if (
      ![
        "user",
        "moderator"
      ].includes(
        target.role
      )
    ) {
      return json({
        ok: false,

        error:
          "Die aktuelle Rolle dieses Accounts kann über den Chat nicht geändert werden."
      }, 409);
    }

    if (
      target.role ===
      role
    ) {
      return json({
        ok: true,

        unchanged:
          true,

        user: {
          ...target,
          role
        }
      });
    }

    try {
      await env.DB.prepare(`
        UPDATE users

        SET role = ?

        WHERE id = ?
      `)
        .bind(
          role,
          target.id
        )
        .run();

    } catch (error) {
      console.error(
        "Role update error:",
        error
      );

      return json({
        ok: false,

        code:
          "ROLE_UPDATE_FAILED",

        error:
          "Die Rolle konnte in der Datenbank nicht gespeichert werden. Falls users.role einen CHECK-Constraint besitzt, muss 'moderator' dort erlaubt werden."
      }, 500);
    }

    const action =
      role ===
        "moderator"
        ? "grant_moderator"
        : "revoke_moderator";

    await addModerationLog(
      env,
      admin.id,
      target.id,
      action,
      {
        username:
          target.username,

        server:
          target.server,

        old_role:
          target.role,

        new_role:
          role
      }
    );

    return json({
      ok: true,

      user: {
        id:
          target.id,

        username:
          target.username,

        server:
          target.server,

        role
      },

      message:
        role ===
          "moderator"
          ? `${target.username} ist jetzt Moderator.`
          : `${target.username} ist kein Moderator mehr.`
    });

  } catch (error) {
    console.error(
      "PUT /api/chat/roles error:",
      error
    );

    return json({
      ok: false,

      error:
        "Die Rolle konnte nicht geändert werden."
    }, 500);
  }
}

export async function onRequestGet() {
  return json({
    ok: false,

    error:
      "Diese Methode wird nicht unterstützt."
  }, 405);
}

export async function onRequestPost() {
  return json({
    ok: false,

    error:
      "Verwende PUT, um Rollen zu ändern."
  }, 405);
}

export async function onRequestDelete() {
  return json({
    ok: false,

    error:
      "Verwende PUT, um Rollen zu ändern."
  }, 405);
}
