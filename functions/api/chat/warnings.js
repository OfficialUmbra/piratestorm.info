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

function isAdmin(user) {
  return Boolean(
    user &&
    user.role === "admin"
  );
}

function isModerator(user) {
  return Boolean(
    user &&
    user.role === "moderator"
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

function cleanText(value) {
  return typeof value ===
    "string"
      ? value.trim()
      : "";
}

async function getUserById(
  env,
  userId
) {
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
    .bind(
      userId
    )
    .first();
}

function canModerateTarget(
  actor,
  target
) {
  if (
    !actor ||
    !target
  ) {
    return false;
  }

  if (
    Number(actor.id) ===
    Number(target.id)
  ) {
    return false;
  }

  if (
    target.role ===
    "admin"
  ) {
    return false;
  }

  if (
    isModerator(actor) &&
    target.role ===
    "moderator"
  ) {
    return false;
  }

  return canModerate(
    actor
  );
}

async function addModerationLog(
  env,
  actorId,
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
        actorId,
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
      "Warning moderation log error:",
      error
    );
  }
}

export async function onRequestPost(
  context
) {
  try {
    const {
      request,
      env
    } = context;

    const actor =
      await getCurrentUser(
        request,
        env
      );

    if (!actor) {
      return json({
        ok: false,

        error:
          "Du musst eingeloggt sein."
      }, 401);
    }

    if (
      !canModerate(
        actor
      )
    ) {
      return json({
        ok: false,

        error:
          "Nur Administratoren und Moderatoren dürfen Spieler verwarnen."
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

    const targetId =
      Number(
        body.user_id ||
        body.target_user_id
      );

    const reason =
      cleanText(
        body.reason
      );

    if (
      !Number.isInteger(
        targetId
      ) ||
      targetId <= 0
    ) {
      return json({
        ok: false,

        error:
          "Ungültiger Spieler."
      }, 400);
    }

    if (
      !reason
    ) {
      return json({
        ok: false,

        error:
          "Bitte gib einen Grund für die Verwarnung an."
      }, 400);
    }

    if (
      reason.length >
      500
    ) {
      return json({
        ok: false,

        error:
          "Der Verwarnungsgrund darf maximal 500 Zeichen lang sein."
      }, 400);
    }

    const target =
      await getUserById(
        env,
        targetId
      );

    if (!target) {
      return json({
        ok: false,

        error:
          "Spieler wurde nicht gefunden."
      }, 404);
    }

    if (
      !canModerateTarget(
        actor,
        target
      )
    ) {
      return json({
        ok: false,

        error:
          target.role ===
            "admin"
            ? "Der Administrator kann nicht verwarnt werden."
            : "Du darfst diesen Spieler nicht verwarnen."
      }, 403);
    }

    const now =
      Math.floor(
        Date.now() / 1000
      );

    const result =
      await env.DB.prepare(`
        INSERT INTO chat_warnings (
          user_id,
          warned_by,
          reason,
          created_at,
          acknowledged_at
        )

        VALUES (?, ?, ?, ?, NULL)
      `)
        .bind(
          target.id,
          actor.id,
          reason,
          now
        )
        .run();

    const warningId =
      result?.meta
        ?.last_row_id ||
      null;

    await addModerationLog(
      env,
      actor.id,
      target.id,
      "warn",
      {
        warning_id:
          warningId,

        username:
          target.username,

        server:
          target.server,

        reason
      }
    );

    return json({
      ok: true,

      warning: {
        id:
          warningId,

        user_id:
          target.id,

        warned_by:
          actor.id,

        warned_by_username:
          actor.username,

        reason,

        created_at:
          now,

        acknowledged_at:
          null
      },

      message:
        `${target.username} wurde verwarnt.`
    }, 201);

  } catch (error) {
    console.error(
      "POST /api/chat/warnings error:",
      error
    );

    return json({
      ok: false,

      error:
        "Die Verwarnung konnte nicht erstellt werden."
    }, 500);
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

    const actor =
      await getCurrentUser(
        request,
        env
      );

    if (!actor) {
      return json({
        ok: false,

        error:
          "Du musst eingeloggt sein."
      }, 401);
    }

    const url =
      new URL(
        request.url
      );

    const targetId =
      Number(
        url.searchParams.get(
          "user_id"
        ) ||
        0
      );

    const own =
      url.searchParams.get(
        "mine"
      ) ===
      "1";

    if (own) {
      const result =
        await env.DB.prepare(`
          SELECT
            w.id,
            w.reason,
            w.created_at,
            w.acknowledged_at,

            u.username
              AS warned_by_username

          FROM chat_warnings w

          LEFT JOIN users u
            ON u.id =
              w.warned_by

          WHERE w.user_id = ?

          ORDER BY
            w.created_at DESC,
            w.id DESC

          LIMIT 100
        `)
          .bind(
            actor.id
          )
          .all();

      return json({
        ok: true,

        warnings:
          result.results ||
          []
      });
    }

    if (
      !canModerate(
        actor
      )
    ) {
      return json({
        ok: false,

        error:
          "Nur Administratoren und Moderatoren dürfen Verwarnungen einsehen."
      }, 403);
    }

    if (
      !Number.isInteger(
        targetId
      ) ||
      targetId <= 0
    ) {
      return json({
        ok: false,

        error:
          "Ungültiger Spieler."
      }, 400);
    }

    const target =
      await getUserById(
        env,
        targetId
      );

    if (!target) {
      return json({
        ok: false,

        error:
          "Spieler wurde nicht gefunden."
      }, 404);
    }

    if (
      isModerator(
        actor
      ) &&
      target.role !==
        "user"
    ) {
      return json({
        ok: false,

        error:
          "Moderatoren können die Verwarnungshistorie dieses Accounts nicht einsehen."
      }, 403);
    }

    if (
      target.role ===
      "admin"
    ) {
      return json({
        ok: false,

        error:
          "Für Administratoren gibt es keine Verwarnungshistorie."
      }, 403);
    }

    const result =
      await env.DB.prepare(`
        SELECT
          w.id,
          w.user_id,
          w.warned_by,
          w.reason,
          w.created_at,
          w.acknowledged_at,

          issuer.username
            AS warned_by_username,

          issuer.role
            AS warned_by_role

        FROM chat_warnings w

        LEFT JOIN users issuer
          ON issuer.id =
            w.warned_by

        WHERE w.user_id = ?

        ORDER BY
          w.created_at DESC,
          w.id DESC

        LIMIT 100
      `)
        .bind(
          targetId
        )
        .all();

    return json({
      ok: true,

      user:
        target,

      count:
        (
          result.results ||
          []
        ).length,

      warnings:
        result.results ||
        []
    });

  } catch (error) {
    console.error(
      "GET /api/chat/warnings error:",
      error
    );

    return json({
      ok: false,

      error:
        "Die Verwarnungen konnten nicht geladen werden."
    }, 500);
  }
}

export async function onRequestPut() {
  return json({
    ok: false,

    error:
      "Verwarnungen werden über /api/chat/status bestätigt."
  }, 405);
}

export async function onRequestDelete() {
  return json({
    ok: false,

    error:
      "Verwarnungen werden nicht gelöscht."
  }, 405);
}
