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

async function requireAdmin(request, env) {
  const user = await getCurrentUser(request, env);

  if (!user) {
    return {
      error: json({
        success: false,
        error: "Du musst angemeldet sein."
      }, 401)
    };
  }

  if (user.role !== "admin") {
    return {
      error: json({
        success: false,
        error: "Keine Admin-Berechtigung."
      }, 403)
    };
  }

  return { user };
}


// ----------------------------------------------------
// GET /api/categories
// Jeder darf Überthemen sehen
// ----------------------------------------------------

export async function onRequestGet(context) {
  try {
    const { request, env } = context;

    const user = await getCurrentUser(request, env);

    const result = await env.DB
      .prepare(`
        SELECT
          categories.id,
          categories.name,
          categories.created_at,
          COUNT(posts.id) AS thread_count
        FROM categories
        LEFT JOIN posts
          ON posts.category = categories.name
        GROUP BY categories.id
        ORDER BY categories.id ASC
      `)
      .all();

    return json({
      success: true,
      is_admin: user?.role === "admin",
      categories: result.results
    });

  } catch (error) {
    console.error(error);

    return json({
      success: false,
      error: "Überthemen konnten nicht geladen werden."
    }, 500);
  }
}


// ----------------------------------------------------
// POST /api/categories
// Neues Überthema – NUR ADMIN
// ----------------------------------------------------

export async function onRequestPost(context) {
  try {
    const { request, env } = context;

    const auth = await requireAdmin(request, env);

    if (auth.error) return auth.error;

    const body = await request.json();

    const name =
      typeof body.name === "string"
        ? body.name.trim()
        : "";

    if (name.length < 2 || name.length > 60) {
      return json({
        success: false,
        error: "Der Name muss zwischen 2 und 60 Zeichen lang sein."
      }, 400);
    }

    const existing = await env.DB
      .prepare(`
        SELECT id
        FROM categories
        WHERE LOWER(name) = LOWER(?)
      `)
      .bind(name)
      .first();

    if (existing) {
      return json({
        success: false,
        error: "Dieses Überthema existiert bereits."
      }, 409);
    }

    const result = await env.DB
      .prepare(`
        INSERT INTO categories (name)
        VALUES (?)
      `)
      .bind(name)
      .run();

    return json({
      success: true,
      message: "Überthema erfolgreich erstellt.",
      category: {
        id: result.meta.last_row_id,
        name
      }
    }, 201);

  } catch (error) {
    console.error(error);

    return json({
      success: false,
      error: "Überthema konnte nicht erstellt werden."
    }, 500);
  }
}


// ----------------------------------------------------
// PUT /api/categories
// Überthema umbenennen – NUR ADMIN
// ----------------------------------------------------

export async function onRequestPut(context) {
  try {
    const { request, env } = context;

    const auth = await requireAdmin(request, env);

    if (auth.error) return auth.error;

    const body = await request.json();

    const categoryId = Number(body.id);

    const newName =
      typeof body.name === "string"
        ? body.name.trim()
        : "";

    if (!Number.isInteger(categoryId) || categoryId < 1) {
      return json({
        success: false,
        error: "Ungültige Überthemen-ID."
      }, 400);
    }

    if (newName.length < 2 || newName.length > 60) {
      return json({
        success: false,
        error: "Der Name muss zwischen 2 und 60 Zeichen lang sein."
      }, 400);
    }

    const category = await env.DB
      .prepare(`
        SELECT id, name
        FROM categories
        WHERE id = ?
      `)
      .bind(categoryId)
      .first();

    if (!category) {
      return json({
        success: false,
        error: "Überthema nicht gefunden."
      }, 404);
    }

    const duplicate = await env.DB
      .prepare(`
        SELECT id
        FROM categories
        WHERE LOWER(name) = LOWER(?)
        AND id <> ?
      `)
      .bind(newName, categoryId)
      .first();

    if (duplicate) {
      return json({
        success: false,
        error: "Ein Überthema mit diesem Namen existiert bereits."
      }, 409);
    }

    /*
      Wichtig:
      Die Posts speichern aktuell den Kategorienamen.
      Deshalb müssen beim Umbenennen auch die Threads
      auf den neuen Namen umgestellt werden.
    */

    await env.DB.batch([
      env.DB
        .prepare(`
          UPDATE posts
          SET category = ?
          WHERE category = ?
        `)
        .bind(newName, category.name),

      env.DB
        .prepare(`
          UPDATE categories
          SET name = ?
          WHERE id = ?
        `)
        .bind(newName, categoryId)
    ]);

    return json({
      success: true,
      message: "Überthema erfolgreich umbenannt."
    });

  } catch (error) {
    console.error(error);

    return json({
      success: false,
      error: "Überthema konnte nicht umbenannt werden."
    }, 500);
  }
}


// ----------------------------------------------------
// DELETE /api/categories
// Überthema löschen – NUR ADMIN
// ----------------------------------------------------

export async function onRequestDelete(context) {
  try {
    const { request, env } = context;

    const auth = await requireAdmin(request, env);

    if (auth.error) return auth.error;

    const body = await request.json();
    const categoryId = Number(body.id);

    if (!Number.isInteger(categoryId) || categoryId < 1) {
      return json({
        success: false,
        error: "Ungültige Überthemen-ID."
      }, 400);
    }

    const category = await env.DB
      .prepare(`
        SELECT id, name
        FROM categories
        WHERE id = ?
      `)
      .bind(categoryId)
      .first();

    if (!category) {
      return json({
        success: false,
        error: "Überthema nicht gefunden."
      }, 404);
    }

    const threadCount = await env.DB
      .prepare(`
        SELECT COUNT(*) AS count
        FROM posts
        WHERE category = ?
      `)
      .bind(category.name)
      .first();

    /*
      Sicherheit:
      Ein Überthema mit vorhandenen Threads wird
      NICHT einfach mitsamt aller Inhalte gelöscht.
    */

    if (Number(threadCount.count) > 0) {
      return json({
        success: false,
        error:
          "Dieses Überthema enthält noch Threads. Verschiebe oder lösche diese zuerst."
      }, 409);
    }

    await env.DB
      .prepare(`
        DELETE FROM categories
        WHERE id = ?
      `)
      .bind(categoryId)
      .run();

    return json({
      success: true,
      message: "Überthema erfolgreich gelöscht."
    });

  } catch (error) {
    console.error(error);

    return json({
      success: false,
      error: "Überthema konnte nicht gelöscht werden."
    }, 500);
  }
}
