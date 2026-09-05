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
  const cookieHeader =
    request.headers.get("Cookie");

  if (!cookieHeader) {
    return null;
  }

  const cookies =
    cookieHeader.split(";");

  for (const cookie of cookies) {
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
    getCookie(
      request,
      "ps_session"
    );

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

  Der Forum-Bann ist eine
  Schreib-/Interaktionssperre.

  Lesen bleibt erlaubt.

  Gesperrt werden:

  - Beiträge erstellen
  - Antworten schreiben
  - Beiträge liken / Like entfernen
  - Kommentare liken / Like entfernen

  Administratoren sind geschützt.
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
// POST /api/post-likes
// ----------------------------------------------------
//
// Like setzen oder wieder entfernen.
//
// Bei aktivem Forum-Bann wird BEIDES
// serverseitig blockiert.
// ----------------------------------------------------

export async function onRequestPost(context) {
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
      return json(
        {
          success: false,
          error:
            "Du musst angemeldet sein, um einen Beitrag zu liken."
        },
        401
      );
    }

    /*
      SERVERSEITIGE FORUM-BANNPRÜFUNG

      Diese Prüfung findet statt, bevor
      irgendeine Änderung an post_likes
      vorgenommen wird.
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
            "Du bist aktuell im Forum gesperrt und kannst keine Beiträge liken.",

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

    /*
      Prüfen, ob der Beitrag existiert.
    */

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

    /*
      Prüfen, ob der Benutzer diesen
      Beitrag bereits geliked hat.
    */

    const existingLike =
      await env.DB
        .prepare(`
          SELECT
            post_id
          FROM post_likes
          WHERE post_id = ?
            AND user_id = ?
          LIMIT 1
        `)
        .bind(
          postId,
          user.id
        )
        .first();

    let liked = false;

    if (existingLike) {

      /*
        Like entfernen.
      */

      await env.DB
        .prepare(`
          DELETE FROM post_likes
          WHERE post_id = ?
            AND user_id = ?
        `)
        .bind(
          postId,
          user.id
        )
        .run();

      liked = false;

    } else {

      /*
        Like hinzufügen.
      */

      await env.DB
        .prepare(`
          INSERT INTO post_likes (
            post_id,
            user_id
          )
          VALUES (?, ?)
        `)
        .bind(
          postId,
          user.id
        )
        .run();

      liked = true;
    }

    /*
      Aktuelle Like-Anzahl ermitteln.
    */

    const countResult =
      await env.DB
        .prepare(`
          SELECT
            COUNT(*) AS count
          FROM post_likes
          WHERE post_id = ?
        `)
        .bind(postId)
        .first();

    return json({
      success: true,

      liked,

      likes:
        Number(
          countResult?.count || 0
        )
    });

  } catch (error) {
    console.error(
      "POST-LIKE ERROR:",
      error
    );

    return json(
      {
        success: false,
        error:
          "Like konnte nicht verarbeitet werden."
      },
      500
    );
  }
}


// ----------------------------------------------------
// Andere Methoden nicht erlaubt
// ----------------------------------------------------

export async function onRequestGet() {
  return json(
    {
      success: false,
      error:
        "Method not allowed."
    },
    405
  );
}

export async function onRequestPut() {
  return json(
    {
      success: false,
      error:
        "Method not allowed."
    },
    405
  );
}

export async function onRequestPatch() {
  return json(
    {
      success: false,
      error:
        "Method not allowed."
    },
    405
  );
}

export async function onRequestDelete() {
  return json(
    {
      success: false,
      error:
        "Method not allowed."
    },
    405
  );
}
