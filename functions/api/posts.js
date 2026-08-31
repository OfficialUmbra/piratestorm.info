const CATEGORIES = [
  "Allgemein",
  "Fragen & Hilfe",
  "Guides",
  "Arena",
  "PvP",
  "Schiffe & Builds",
  "Gilden",
  "Screenshots"
];

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

  if (!cookieHeader) {
    return null;
  }

  const cookies = cookieHeader.split(";");

  for (const cookie of cookies) {
    const [key, ...valueParts] = cookie.trim().split("=");

    if (key === name) {
      return valueParts.join("=");
    }
  }

  return null;
}

async function getCurrentUser(request, env) {
  const sessionId = getCookie(request, "ps_session");

  if (!sessionId) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);

  return await env.DB
    .prepare(`
      SELECT users.id, users.username, users.server
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.id = ?
      AND sessions.expires_at > ?
    `)
    .bind(sessionId, now)
    .first();
}


// ----------------------------------------------------
// GET /api/posts
// Alle Beiträge abrufen
// ----------------------------------------------------

export async function onRequestGet(context) {
  try {
    const { env } = context;

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
// Neuen Beitrag erstellen
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

    if (!CATEGORIES.includes(category)) {
      return json({
        success: false,
        error: "Ungültige Kategorie."
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
