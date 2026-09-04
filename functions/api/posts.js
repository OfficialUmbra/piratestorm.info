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

async function categoryExists(env, category) {
  return await env.DB
    .prepare(`
      SELECT id
      FROM categories
      WHERE name = ?
    `)
    .bind(category)
    .first();
}


// ----------------------------------------------------
// GET /api/posts
// ----------------------------------------------------

export async function onRequestGet(context) {
  try {
    const { request, env } = context;

    const currentUser = await getCurrentUser(request, env);

    const result = await env.DB
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
            WHERE post_likes.post_id = posts.id
          ) AS likes,

          (
            SELECT COUNT(*)
            FROM comments
            WHERE comments.post_id = posts.id
          ) AS comments

        FROM posts

        JOIN users
          ON users.id = posts.user_id

        ORDER BY posts.created_at DESC
      `)
      .all();

    return json({
      success: true,
      is_admin: currentUser?.role === "admin",
      posts: result.results
    });

  } catch (error) {
    console.error(error);

    return json({
      success: false,
      error: "Beiträge konnten nicht geladen werden."
    }, 500);
  }
}


// ----------------------------------------------------
// POST /api/posts
// Eingeloggte Benutzer dürfen Threads erstellen
// ----------------------------------------------------

export async function onRequestPost(context) {
  try {
    const { request, env } = context;

    const user = await getCurrentUser(request, env);

    if (!user) {
      return json({
        success: false,
        error: "Du musst angemeldet sein, um einen Beitrag zu erstellen."
      }, 401);
    }

    const body = await request.json();

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
      await categoryExists(env, category);

    if (!existingCategory) {
      return json({
        success: false,
        error: "Dieses Überthema existiert nicht."
      }, 400);
    }

    if (title.length < 3 || title.length > 120) {
      return json({
        success: false,
        error: "Der Titel muss zwischen 3 und 120 Zeichen lang sein."
      }, 400);
    }

    if (content.length < 1 || content.length > 10000) {
      return json({
        success: false,
        error: "Der Beitrag darf maximal 10.000 Zeichen enthalten."
      }, 400);
    }

    const result = await env.DB
      .prepare(`
        INSERT INTO posts
        (user_id, category, title, content)
        VALUES (?, ?, ?, ?)
      `)
      .bind(
        user.id,
        category,
        title,
        content
      )
      .run();

    return json({
      success: true,
      message: "Beitrag erfolgreich erstellt.",
      post: {
        id: result.meta.last_row_id,
        user_id: user.id,
        username: user.username,
        server: user.server,
        role: user.role,
        category,
        title,
        content
      }
    }, 201);

  } catch (error) {
    console.error(error);

    return json({
      success: false,
      error: "Der Beitrag konnte nicht erstellt werden."
    }, 500);
  }
}


// ----------------------------------------------------
// PUT /api/posts
// Thread bearbeiten – NUR ADMIN
// ----------------------------------------------------

export async function onRequestPut(context) {
  try {
    const { request, env } = context;

    const user = await getCurrentUser(request, env);

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

    const postId = Number(body.id);

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

    if (!Number.isInteger(postId) || postId < 1) {
      return json({
        success: false,
        error: "Ungültige Beitrags-ID."
      }, 400);
    }

    const existingCategory =
      await categoryExists(env, category);

    if (!existingCategory) {
      return json({
        success: false,
        error: "Dieses Überthema existiert nicht."
      }, 400);
    }

    if (title.length < 3 || title.length > 120) {
      return json({
        success: false,
        error: "Der Titel muss zwischen 3 und 120 Zeichen lang sein."
      }, 400);
    }

    if (content.length < 1 || content.length > 10000) {
      return json({
        success: false,
        error: "Der Beitrag darf maximal 10.000 Zeichen enthalten."
      }, 400);
    }

    const existingPost = await env.DB
      .prepare(`
        SELECT id
        FROM posts
        WHERE id = ?
      `)
      .bind(postId)
      .first();

    if (!existingPost) {
      return json({
        success: false,
        error: "Beitrag nicht gefunden."
      }, 404);
    }

    await env.DB
      .prepare(`
        UPDATE posts
        SET category = ?, title = ?, content = ?
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
      message: "Beitrag erfolgreich bearbeitet."
    });

  } catch (error) {
    console.error(error);

    return json({
      success: false,
      error: "Der Beitrag konnte nicht bearbeitet werden."
    }, 500);
  }
}


// ----------------------------------------------------
// DELETE /api/posts
// Thread löschen – NUR ADMIN
// ----------------------------------------------------

export async function onRequestDelete(context) {
  try {
    const { request, env } = context;

    const user = await getCurrentUser(request, env);

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
    const postId = Number(body.id);

    if (!Number.isInteger(postId) || postId < 1) {
      return json({
        success: false,
        error: "Ungültige Beitrags-ID."
      }, 400);
    }

    const existingPost = await env.DB
      .prepare(`
        SELECT id
        FROM posts
        WHERE id = ?
      `)
      .bind(postId)
      .first();

    if (!existingPost) {
      return json({
        success: false,
        error: "Beitrag nicht gefunden."
      }, 404);
    }

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

    await env.DB
      .prepare(`
        DELETE FROM comments
        WHERE post_id = ?
      `)
      .bind(postId)
      .run();

    await env.DB
      .prepare(`
        DELETE FROM post_likes
        WHERE post_id = ?
      `)
      .bind(postId)
      .run();

    await env.DB
      .prepare(`
        DELETE FROM posts
        WHERE id = ?
      `)
      .bind(postId)
      .run();

    return json({
      success: true,
      message: "Beitrag erfolgreich gelöscht."
    });

  } catch (error) {
    console.error(error);

    return json({
      success: false,
      error: "Der Beitrag konnte nicht gelöscht werden."
    }, 500);
  }
}
