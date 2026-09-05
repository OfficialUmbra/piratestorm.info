function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store"
    }
  });
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;

  for (const cookie of cookieHeader.split(";")) {
    const [key, ...valueParts] =
      cookie.trim().split("=");

    if (key === name) {
      return valueParts.join("=");
    }
  }

  return null;
}

async function getCurrentUser(request, env) {
  const sessionId =
    getCookie(request, "ps_session");

  if (!sessionId) {
    return null;
  }

  const now =
    Math.floor(Date.now() / 1000);

  return await env.DB
    .prepare(`
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
      sessionId,
      now
    )
    .first();
}


/*
  ----------------------------------------------------
  FORUM-BANN
  ----------------------------------------------------

  Der Forum-Bann ist ausschließlich
  eine Schreib-/Interaktionssperre.

  Gebannte Nutzer dürfen weiterhin:

  ✓ Forum lesen
  ✓ Beiträge lesen
  ✓ Kommentare lesen

  Sie dürfen NICHT:

  ✗ neue Beiträge erstellen
  ✗ Kommentare schreiben
  ✗ Beiträge liken
  ✗ Kommentare liken

  Admins sind grundsätzlich geschützt.
*/

async function expireOldForumBans(env) {
  const now =
    Math.floor(Date.now() / 1000);

  await env.DB
    .prepare(`
      UPDATE forum_bans
      SET active = 0
      WHERE active = 1
        AND expires_at IS NOT NULL
        AND expires_at <= ?
    `)
    .bind(now)
    .run();
}

async function getActiveForumBan(
  env,
  user
) {
  if (!user) {
    return null;
  }

  /*
    Administratoren werden niemals
    durch Forum-Banns eingeschränkt.
  */
  if (user.role === "admin") {
    return null;
  }

  await expireOldForumBans(env);

  const now =
    Math.floor(Date.now() / 1000);

  const ban =
    await env.DB
      .prepare(`
        SELECT
          id,
          user_id,
          banned_by,
          reason,
          banned_at,
          expires_at,
          active
        FROM forum_bans
        WHERE user_id = ?
          AND active = 1
          AND (
            expires_at IS NULL
            OR expires_at > ?
          )
        ORDER BY banned_at DESC
        LIMIT 1
      `)
      .bind(
        user.id,
        now
      )
      .first();

  return ban || null;
}

function serializeForumBan(ban) {
  if (!ban) {
    return null;
  }

  const now =
    Math.floor(Date.now() / 1000);

  const expiresAt =
    ban.expires_at === null
      ? null
      : Number(ban.expires_at);

  return {
    id:
      Number(ban.id),

    reason:
      ban.reason || "",

    banned_at:
      Number(ban.banned_at),

    expires_at:
      expiresAt,

    permanent:
      expiresAt === null,

    remaining_seconds:
      expiresAt === null
        ? null
        : Math.max(
            0,
            expiresAt - now
          )
  };
}


// ----------------------------------------------------
// GET /api/comments?post_id=1
// ----------------------------------------------------
//
// Kommentare bleiben auch für
// forum-gesperrte Nutzer lesbar.
// ----------------------------------------------------

export async function onRequestGet(context) {
  try {
    const { request, env } = context;

    const currentUser =
      await getCurrentUser(
        request,
        env
      );

    const url =
      new URL(request.url);

    const postId =
      Number(
        url.searchParams.get(
          "post_id"
        )
      );

    if (
      !Number.isInteger(postId) ||
      postId < 1
    ) {
      return json(
        {
          success: false,
          error:
            "Ungültige Beitrags-ID."
        },
        400
      );
    }

    const post =
      await env.DB
        .prepare(`
          SELECT id
          FROM posts
          WHERE id = ?
          LIMIT 1
        `)
        .bind(postId)
        .first();

    if (!post) {
      return json(
        {
          success: false,
          error:
            "Beitrag wurde nicht gefunden."
        },
        404
      );
    }

    const result =
      await env.DB
        .prepare(`
          SELECT
            comments.id,
            comments.post_id,
            comments.content,
            comments.created_at,

            users.id AS user_id,
            users.username,
            users.server,
            users.role,
            users.avatar_symbol,
            users.avatar_color,

            (
              SELECT COUNT(*)
              FROM comment_likes
              WHERE
                comment_likes.comment_id =
                comments.id
            ) AS likes

          FROM comments

          JOIN users
            ON users.id =
               comments.user_id

          WHERE comments.post_id = ?

          ORDER BY
            comments.created_at ASC
        `)
        .bind(postId)
        .all();

    /*
      Bannstatus für das Frontend mitsenden.

      So können wir in V26.2 direkt
      das Antwortfeld deaktivieren und
      den Bannhinweis anzeigen.
    */

    let forumBan = null;

    if (currentUser) {
      forumBan =
        await getActiveForumBan(
          env,
          currentUser
        );
    }

    return json({
      success: true,

      is_admin:
        currentUser?.role === "admin",

      forum_banned:
        Boolean(forumBan),

      forum_ban:
        serializeForumBan(
          forumBan
        ),

      comments:
        result.results || []
    });

  } catch (error) {
    console.error(
      "Comments GET error:",
      error
    );

    return json(
      {
        success: false,
        error:
          "Kommentare konnten nicht geladen werden."
      },
      500
    );
  }
}


// ----------------------------------------------------
// POST /api/comments
// ----------------------------------------------------
//
// Jeder eingeloggte Benutzer darf antworten.
//
// Ausnahme:
//
// Aktiver Forum-Bann = Schreibsperre.
// ----------------------------------------------------

export async function onRequestPost(context) {
  try {
    const { request, env } = context;

    const user =
      await getCurrentUser(
        request,
        env
      );

    if (!user) {
      return json(
        {
          success: false,
          error:
            "Du musst angemeldet sein, um zu kommentieren."
        },
        401
      );
    }

    /*
      SERVERSEITIGE FORUM-BANNPRÜFUNG

      Dadurch kann ein gesperrter Nutzer
      auch durch direkte API-Aufrufe
      keine Antwort erstellen.
    */

    const forumBan =
      await getActiveForumBan(
        env,
        user
      );

    if (forumBan) {
      return json(
        {
          success: false,

          error:
            "Du bist aktuell im Forum gesperrt und kannst keine Antworten schreiben.",

          code:
            "FORUM_BANNED",

          forum_banned:
            true,

          forum_ban:
            serializeForumBan(
              forumBan
            )
        },
        403
      );
    }

    let body;

    try {
      body =
        await request.json();
    } catch {
      return json(
        {
          success: false,
          error:
            "Ungültige Anfrage."
        },
        400
      );
    }

    const postId =
      Number(
        body.post_id
      );

    const content =
      typeof body.content === "string"
        ? body.content.trim()
        : "";

    if (
      !Number.isInteger(postId) ||
      postId < 1
    ) {
      return json(
        {
          success: false,
          error:
            "Ungültige Beitrags-ID."
        },
        400
      );
    }

    if (
      content.length < 1 ||
      content.length > 5000
    ) {
      return json(
        {
          success: false,
          error:
            "Der Kommentar darf maximal 5.000 Zeichen enthalten."
        },
        400
      );
    }

    const post =
      await env.DB
        .prepare(`
          SELECT id
          FROM posts
          WHERE id = ?
          LIMIT 1
        `)
        .bind(postId)
        .first();

    if (!post) {
      return json(
        {
          success: false,
          error:
            "Der Beitrag wurde nicht gefunden."
        },
        404
      );
    }

    const result =
      await env.DB
        .prepare(`
          INSERT INTO comments (
            post_id,
            user_id,
            content
          )
          VALUES (?, ?, ?)
        `)
        .bind(
          postId,
          user.id,
          content
        )
        .run();

    return json(
      {
        success: true,

        message:
          "Kommentar erfolgreich erstellt.",

        comment: {
          id:
            result.meta.last_row_id,

          post_id:
            postId,

          user_id:
            user.id,

          username:
            user.username,

          server:
            user.role === "admin"
              ? "ADMIN"
              : user.server,

          role:
            user.role,

          content
        }
      },
      201
    );

  } catch (error) {
    console.error(
      "Comments POST error:",
      error
    );

    return json(
      {
        success: false,
        error:
          "Der Kommentar konnte nicht erstellt werden."
      },
      500
    );
  }
}


// ----------------------------------------------------
// PUT /api/comments
// ----------------------------------------------------
//
// Kommentar bearbeiten – NUR ADMIN
//
// Admins sind gegen Forum-Banns geschützt.
// ----------------------------------------------------

export async function onRequestPut(context) {
  try {
    const { request, env } = context;

    const user =
      await getCurrentUser(
        request,
        env
      );

    if (!user) {
      return json(
        {
          success: false,
          error:
            "Du musst angemeldet sein."
        },
        401
      );
    }

    if (user.role !== "admin") {
      return json(
        {
          success: false,
          error:
            "Keine Admin-Berechtigung."
        },
        403
      );
    }

    let body;

    try {
      body =
        await request.json();
    } catch {
      return json(
        {
          success: false,
          error:
            "Ungültige Anfrage."
        },
        400
      );
    }

    const commentId =
      Number(
        body.id
      );

    const content =
      typeof body.content === "string"
        ? body.content.trim()
        : "";

    if (
      !Number.isInteger(commentId) ||
      commentId < 1
    ) {
      return json(
        {
          success: false,
          error:
            "Ungültige Kommentar-ID."
        },
        400
      );
    }

    if (
      content.length < 1 ||
      content.length > 5000
    ) {
      return json(
        {
          success: false,
          error:
            "Der Kommentar darf maximal 5.000 Zeichen enthalten."
        },
        400
      );
    }

    const existingComment =
      await env.DB
        .prepare(`
          SELECT id
          FROM comments
          WHERE id = ?
          LIMIT 1
        `)
        .bind(commentId)
        .first();

    if (!existingComment) {
      return json(
        {
          success: false,
          error:
            "Kommentar nicht gefunden."
        },
        404
      );
    }

    await env.DB
      .prepare(`
        UPDATE comments
        SET content = ?
        WHERE id = ?
      `)
      .bind(
        content,
        commentId
      )
      .run();

    return json({
      success: true,
      message:
        "Kommentar erfolgreich bearbeitet."
    });

  } catch (error) {
    console.error(
      "Comments PUT error:",
      error
    );

    return json(
      {
        success: false,
        error:
          "Der Kommentar konnte nicht bearbeitet werden."
      },
      500
    );
  }
}


// ----------------------------------------------------
// DELETE /api/comments
// ----------------------------------------------------
//
// Kommentar löschen – NUR ADMIN
// ----------------------------------------------------

export async function onRequestDelete(context) {
  try {
    const { request, env } = context;

    const user =
      await getCurrentUser(
        request,
        env
      );

    if (!user) {
      return json(
        {
          success: false,
          error:
            "Du musst angemeldet sein."
        },
        401
      );
    }

    if (user.role !== "admin") {
      return json(
        {
          success: false,
          error:
            "Keine Admin-Berechtigung."
        },
        403
      );
    }

    let body;

    try {
      body =
        await request.json();
    } catch {
      return json(
        {
          success: false,
          error:
            "Ungültige Anfrage."
        },
        400
      );
    }

    const commentId =
      Number(
        body.id
      );

    if (
      !Number.isInteger(commentId) ||
      commentId < 1
    ) {
      return json(
        {
          success: false,
          error:
            "Ungültige Kommentar-ID."
        },
        400
      );
    }

    const existingComment =
      await env.DB
        .prepare(`
          SELECT id
          FROM comments
          WHERE id = ?
          LIMIT 1
        `)
        .bind(commentId)
        .first();

    if (!existingComment) {
      return json(
        {
          success: false,
          error:
            "Kommentar nicht gefunden."
        },
        404
      );
    }

    /*
      Zuerst Likes auf dem Kommentar löschen.
    */

    await env.DB
      .prepare(`
        DELETE FROM comment_likes
        WHERE comment_id = ?
      `)
      .bind(commentId)
      .run();

    /*
      Danach den Kommentar selbst.
    */

    await env.DB
      .prepare(`
        DELETE FROM comments
        WHERE id = ?
      `)
      .bind(commentId)
      .run();

    return json({
      success: true,
      message:
        "Kommentar erfolgreich gelöscht."
    });

  } catch (error) {
    console.error(
      "Comments DELETE error:",
      error
    );

    return json(
      {
        success: false,
        error:
          "Der Kommentar konnte nicht gelöscht werden."
      },
      500
    );
  }
}
