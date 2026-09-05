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

async function categoryExists(
  env,
  category
) {
  return await env.DB
    .prepare(`
      SELECT id
      FROM categories
      WHERE name = ?
      LIMIT 1
    `)
    .bind(category)
    .first();
}

/*
  ----------------------------------------------------
  FORUM-BANN
  ----------------------------------------------------

  Ein Forum-Bann ist bei PirateStorm.info
  ausschließlich eine Schreib-/Interaktionssperre.

  Gebannte Nutzer dürfen:

  ✓ Forum lesen
  ✓ Beiträge lesen
  ✓ Kommentare lesen

  Gebannte Nutzer dürfen NICHT:

  ✗ neue Beiträge erstellen
  ✗ Kommentare schreiben
  ✗ Beiträge liken
  ✗ Kommentare liken

  Admins sind immer geschützt.
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
    Admins können niemals durch einen
    Forum-Bann eingeschränkt werden.
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
    id: Number(ban.id),

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
// GET /api/posts
// ----------------------------------------------------
//
// Forum lesen bleibt auch bei einem Forum-Bann
// ausdrücklich erlaubt.
// ----------------------------------------------------

export async function onRequestGet(context) {
  try {
    const { request, env } = context;

    const currentUser =
      await getCurrentUser(
        request,
        env
      );

    const result =
      await env.DB
        .prepare(`
          SELECT
            posts.id,
            posts.category,
            posts.title,
            posts.content,
            posts.created_at,

            users.id AS user_id,
            users.username,
            users.server,
            users.role,
            users.avatar_symbol,
            users.avatar_color,

            (
              SELECT COUNT(*)
              FROM post_likes
              WHERE post_likes.post_id =
                    posts.id
            ) AS likes,

            (
              SELECT COUNT(*)
              FROM comments
              WHERE comments.post_id =
                    posts.id
            ) AS comments

          FROM posts

          JOIN users
            ON users.id =
               posts.user_id

          ORDER BY
            posts.created_at DESC
        `)
        .all();

    /*
      Bannstatus geben wir für eingeloggte
      Nutzer zusätzlich zurück.

      Dadurch kann das Frontend später sofort
      Eingabefelder deaktivieren und den
      Sperrhinweis anzeigen.

      Das Forum selbst bleibt trotzdem lesbar.
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

      posts:
        result.results || []
    });

  } catch (error) {
    console.error(
      "Posts GET error:",
      error
    );

    return json(
      {
        success: false,
        error:
          "Beiträge konnten nicht geladen werden."
      },
      500
    );
  }
}


// ----------------------------------------------------
// POST /api/posts
// ----------------------------------------------------
//
// Eingeloggte Benutzer dürfen Threads erstellen.
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
            "Du musst angemeldet sein, um einen Beitrag zu erstellen."
        },
        401
      );
    }

    /*
      SERVERSEITIGE BANNPRÜFUNG

      Diese Prüfung ist entscheidend.

      Selbst wenn jemand das Frontend manipuliert
      oder /api/posts direkt aufruft, kann ein
      gebannter Nutzer keinen Beitrag erstellen.
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
            "Du bist aktuell im Forum gesperrt und kannst keine Beiträge erstellen.",

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

    const category =
      typeof body.category === "string"
        ? body.category.trim()
        : "";

    const title =
      typeof body.title === "string"
        ? body.title.trim()
        : "";

    const content =
      typeof body.content === "string"
        ? body.content.trim()
        : "";

    const existingCategory =
      await categoryExists(
        env,
        category
      );

    if (!existingCategory) {
      return json(
        {
          success: false,
          error:
            "Dieses Überthema existiert nicht."
        },
        400
      );
    }

    if (
      title.length < 3 ||
      title.length > 120
    ) {
      return json(
        {
          success: false,
          error:
            "Der Titel muss zwischen 3 und 120 Zeichen lang sein."
        },
        400
      );
    }

    if (
      content.length < 1 ||
      content.length > 10000
    ) {
      return json(
        {
          success: false,
          error:
            "Der Beitrag darf maximal 10.000 Zeichen enthalten."
        },
        400
      );
    }

    const result =
      await env.DB
        .prepare(`
          INSERT INTO posts (
            user_id,
            category,
            title,
            content
          )
          VALUES (?, ?, ?, ?)
        `)
        .bind(
          user.id,
          category,
          title,
          content
        )
        .run();

    return json(
      {
        success: true,

        message:
          "Beitrag erfolgreich erstellt.",

        post: {
          id:
            result.meta.last_row_id,

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

          category,
          title,
          content
        }
      },
      201
    );

  } catch (error) {
    console.error(
      "Posts POST error:",
      error
    );

    return json(
      {
        success: false,
        error:
          "Der Beitrag konnte nicht erstellt werden."
      },
      500
    );
  }
}


// ----------------------------------------------------
// PUT /api/posts
// ----------------------------------------------------
//
// Thread bearbeiten – NUR ADMIN
//
// Admins sind gegen Forum-Banns geschützt,
// deshalb ist hier keine zusätzliche
// Bannprüfung notwendig.
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

    const postId =
      Number(body.id);

    const category =
      typeof body.category === "string"
        ? body.category.trim()
        : "";

    const title =
      typeof body.title === "string"
        ? body.title.trim()
        : "";

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

    const existingCategory =
      await categoryExists(
        env,
        category
      );

    if (!existingCategory) {
      return json(
        {
          success: false,
          error:
            "Dieses Überthema existiert nicht."
        },
        400
      );
    }

    if (
      title.length < 3 ||
      title.length > 120
    ) {
      return json(
        {
          success: false,
          error:
            "Der Titel muss zwischen 3 und 120 Zeichen lang sein."
        },
        400
      );
    }

    if (
      content.length < 1 ||
      content.length > 10000
    ) {
      return json(
        {
          success: false,
          error:
            "Der Beitrag darf maximal 10.000 Zeichen enthalten."
        },
        400
      );
    }

    const existingPost =
      await env.DB
        .prepare(`
          SELECT id
          FROM posts
          WHERE id = ?
          LIMIT 1
        `)
        .bind(postId)
        .first();

    if (!existingPost) {
      return json(
        {
          success: false,
          error:
            "Beitrag nicht gefunden."
        },
        404
      );
    }

    await env.DB
      .prepare(`
        UPDATE posts
        SET
          category = ?,
          title = ?,
          content = ?
        WHERE id = ?
      `)
      .bind(
        category,
        title,
        content,
        postId
      )
      .run();

    return json({
      success: true,
      message:
        "Beitrag erfolgreich bearbeitet."
    });

  } catch (error) {
    console.error(
      "Posts PUT error:",
      error
    );

    return json(
      {
        success: false,
        error:
          "Der Beitrag konnte nicht bearbeitet werden."
      },
      500
    );
  }
}


// ----------------------------------------------------
// DELETE /api/posts
// ----------------------------------------------------
//
// Thread löschen – NUR ADMIN
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

    const postId =
      Number(body.id);

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

    const existingPost =
      await env.DB
        .prepare(`
          SELECT id
          FROM posts
          WHERE id = ?
          LIMIT 1
        `)
        .bind(postId)
        .first();

    if (!existingPost) {
      return json(
        {
          success: false,
          error:
            "Beitrag nicht gefunden."
        },
        404
      );
    }

    /*
      Erst Likes der Kommentare löschen.
    */

    await env.DB
      .prepare(`
        DELETE FROM comment_likes
        WHERE comment_id IN (
          SELECT id
          FROM comments
          WHERE post_id = ?
        )
      `)
      .bind(postId)
      .run();

    /*
      Danach Kommentare.
    */

    await env.DB
      .prepare(`
        DELETE FROM comments
        WHERE post_id = ?
      `)
      .bind(postId)
      .run();

    /*
      Likes des Beitrags.
    */

    await env.DB
      .prepare(`
        DELETE FROM post_likes
        WHERE post_id = ?
      `)
      .bind(postId)
      .run();

    /*
      Zuletzt den Beitrag selbst.
    */

    await env.DB
      .prepare(`
        DELETE FROM posts
        WHERE id = ?
      `)
      .bind(postId)
      .run();

    return json({
      success: true,
      message:
        "Beitrag erfolgreich gelöscht."
    });

  } catch (error) {
    console.error(
      "Posts DELETE error:",
      error
    );

    return json(
      {
        success: false,
        error:
          "Der Beitrag konnte nicht gelöscht werden."
      },
      500
    );
  }
}
