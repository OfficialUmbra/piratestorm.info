function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8"
    }
  });
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;

  for (const cookie of cookieHeader.split(";")) {
    const [key, ...valueParts] = cookie.trim().split("=");

    if (key === name) {
      return valueParts.join("=");
    }
  }

  return null;
}

async function getCurrentUser(request, env) {
  const sessionId = getCookie(request, "ps_session");
  if (!sessionId) return null;

  const now = Math.floor(Date.now() / 1000);

  return await env.DB
    .prepare(`
      SELECT
        users.id,
        users.username,
        users.server,
        users.role
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.id = ?
      AND sessions.expires_at > ?
    `)
    .bind(sessionId, now)
    .first();
}


// ----------------------------------------------------
// GET /api/comments?post_id=1
// ----------------------------------------------------

export async function onRequestGet(context) {
  try {
    const { request, env } = context;

    const currentUser =
      await getCurrentUser(request, env);

    const url = new URL(request.url);
    const postId =
      Number(url.searchParams.get("post_id"));

    if (!Number.isInteger(postId) || postId < 1) {
      return json({
        success: false,
        error: "Ungültige Beitrags-ID."
      }, 400);
    }

    const post = await env.DB
      .prepare(`
        SELECT id
        FROM posts
        WHERE id = ?
      `)
      .bind(postId)
      .first();

    if (!post) {
      return json({
        success: false,
        error: "Beitrag wurde nicht gefunden."
      }, 404);
    }

    const result = await env.DB
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
            WHERE comment_likes.comment_id = comments.id
          ) AS likes

        FROM comments

        JOIN users
          ON users.id = comments.user_id

        WHERE comments.post_id = ?

        ORDER BY comments.created_at ASC
      `)
      .bind(postId)
      .all();

    return json({
      success: true,
      is_admin: currentUser?.role === "admin",
      comments: result.results
    });

  } catch (error) {
    console.error(error);

    return json({
      success: false,
      error: "Kommentare konnten nicht geladen werden."
    }, 500);
  }
}


// ----------------------------------------------------
// POST /api/comments
// Jeder eingeloggte Benutzer darf antworten
// ----------------------------------------------------

export async function onRequestPost(context) {
  try {
    const { request, env } = context;

    const user =
      await getCurrentUser(request, env);

    if (!user) {
      return json({
        success: false,
        error: "Du musst angemeldet sein, um zu kommentieren."
      }, 401);
    }

    const body = await request.json();

    const postId = Number(body.post_id);

    const content =
      typeof body.content === "string"
        ? body.content.trim()
        : "";

    if (!Number.isInteger(postId) || postId < 1) {
      return json({
        success: false,
        error: "Ungültige Beitrags-ID."
      }, 400);
    }

    if (content.length < 1 || content.length > 5000) {
      return json({
        success: false,
        error: "Der Kommentar darf maximal 5.000 Zeichen enthalten."
      }, 400);
    }

    const post = await env.DB
      .prepare(`
        SELECT id
        FROM posts
        WHERE id = ?
      `)
      .bind(postId)
      .first();

    if (!post) {
      return json({
        success: false,
        error: "Der Beitrag wurde nicht gefunden."
      }, 404);
    }

    const result = await env.DB
      .prepare(`
        INSERT INTO comments
        (post_id, user_id, content)
        VALUES (?, ?, ?)
      `)
      .bind(
        postId,
        user.id,
        content
      )
      .run();

    return json({
      success: true,
      message: "Kommentar erfolgreich erstellt.",
      comment: {
        id: result.meta.last_row_id,
        post_id: postId,
        user_id: user.id,
        username: user.username,
        server: user.server,
        role: user.role,
        content
      }
    }, 201);

  } catch (error) {
    console.error(error);

    return json({
      success: false,
      error: "Der Kommentar konnte nicht erstellt werden."
    }, 500);
  }
}


// ----------------------------------------------------
// PUT /api/comments
// Kommentar bearbeiten – NUR ADMIN
// ----------------------------------------------------

export async function onRequestPut(context) {
  try {
    const { request, env } = context;

    const user =
      await getCurrentUser(request, env);

    if (!user) {
      return json({
        success: false,
        error: "Du musst angemeldet sein."
      }, 401);
    }

    if (user.role !== "admin") {
      return json({
        success: false,
        error: "Keine Admin-Berechtigung."
      }, 403);
    }

    const body = await request.json();

    const commentId = Number(body.id);

    const content =
      typeof body.content === "string"
        ? body.content.trim()
        : "";

    if (!Number.isInteger(commentId) || commentId < 1) {
      return json({
        success: false,
        error: "Ungültige Kommentar-ID."
      }, 400);
    }

    if (content.length < 1 || content.length > 5000) {
      return json({
        success: false,
        error: "Der Kommentar darf maximal 5.000 Zeichen enthalten."
      }, 400);
    }

    const existingComment = await env.DB
      .prepare(`
        SELECT id
        FROM comments
        WHERE id = ?
      `)
      .bind(commentId)
      .first();

    if (!existingComment) {
      return json({
        success: false,
        error: "Kommentar nicht gefunden."
      }, 404);
    }

    await env.DB
      .prepare(`
        UPDATE comments
        SET content = ?
        WHERE id = ?
      `)
      .bind(content, commentId)
      .run();

    return json({
      success: true,
      message: "Kommentar erfolgreich bearbeitet."
    });

  } catch (error) {
    console.error(error);

    return json({
      success: false,
      error: "Der Kommentar konnte nicht bearbeitet werden."
    }, 500);
  }
}


// ----------------------------------------------------
// DELETE /api/comments
// Kommentar löschen – NUR ADMIN
// ----------------------------------------------------

export async function onRequestDelete(context) {
  try {
    const { request, env } = context;

    const user =
      await getCurrentUser(request, env);

    if (!user) {
      return json({
        success: false,
        error: "Du musst angemeldet sein."
      }, 401);
    }

    if (user.role !== "admin") {
      return json({
        success: false,
        error: "Keine Admin-Berechtigung."
      }, 403);
    }

    const body = await request.json();

    const commentId = Number(body.id);

    if (!Number.isInteger(commentId) || commentId < 1) {
      return json({
        success: false,
        error: "Ungültige Kommentar-ID."
      }, 400);
    }

    const existingComment = await env.DB
      .prepare(`
        SELECT id
        FROM comments
        WHERE id = ?
      `)
      .bind(commentId)
      .first();

    if (!existingComment) {
      return json({
        success: false,
        error: "Kommentar nicht gefunden."
      }, 404);
    }

    await env.DB
      .prepare(`
        DELETE FROM comment_likes
        WHERE comment_id = ?
      `)
      .bind(commentId)
      .run();

    await env.DB
      .prepare(`
        DELETE FROM comments
        WHERE id = ?
      `)
      .bind(commentId)
      .run();

    return json({
      success: true,
      message: "Kommentar erfolgreich gelöscht."
    });

  } catch (error) {
    console.error(error);

    return json({
      success: false,
      error: "Der Kommentar konnte nicht gelöscht werden."
    }, 500);
  }
}
