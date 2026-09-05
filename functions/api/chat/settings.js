/*
 * =====================================================
 * PirateStorm.info
 * Chat Settings API – V25
 *
 * GET  /api/chat/settings
 * PUT  /api/chat/settings
 *
 * Einstellungen:
 *
 * - show_system_messages
 * - show_timestamps
 * - emoji_picker_enabled
 *
 * Die Einstellungen gelten pro Benutzerkonto.
 * =====================================================
 */


/*
 * =====================================================
 * RESPONSE
 * =====================================================
 */

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=utf-8",

        "Cache-Control":
          "no-store"
      }
    }
  );
}


/*
 * =====================================================
 * COOKIE
 * =====================================================
 */

function getCookie(
  request,
  name
) {
  const cookie =
    request.headers.get(
      "Cookie"
    ) || "";

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


/*
 * =====================================================
 * CURRENT USER
 * =====================================================
 *
 * WICHTIG:
 *
 * Unsere Session-ID liegt in:
 *
 * sessions.id
 *
 * NICHT sessions.token.
 * =====================================================
 */

async function getCurrentUser(
  request,
  env
) {
  const sessionId =
    getCookie(
      request,
      "ps_session"
    );

  if (!sessionId) {
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
      sessionId,
      now
    )
    .first();
}


/*
 * =====================================================
 * BOOLEAN HELPERS
 * =====================================================
 */

function databaseBoolean(value) {
  return Number(value) === 1;
}


/*
 * Nur echte Boolean-Werte akzeptieren.
 *
 * true  -> 1
 * false -> 0
 *
 * Dadurch kann niemand versehentlich Strings wie
 * "false" senden, die JavaScript sonst als truthy
 * interpretieren könnte.
 */

function parseBoolean(value) {
  if (
    value === true
  ) {
    return 1;
  }

  if (
    value === false
  ) {
    return 0;
  }

  return null;
}


/*
 * =====================================================
 * DEFAULT SETTINGS
 * =====================================================
 */

function defaultSettings() {
  return {
    show_system_messages:
      true,

    show_timestamps:
      true,

    emoji_picker_enabled:
      true
  };
}


/*
 * =====================================================
 * LOAD SETTINGS
 * =====================================================
 */

async function loadSettings(
  env,
  userId
) {
  const row =
    await env.DB.prepare(`
      SELECT
        user_id,
        show_system_messages,
        show_timestamps,
        emoji_picker_enabled,
        created_at,
        updated_at

      FROM chat_user_settings

      WHERE user_id = ?

      LIMIT 1
    `)
      .bind(
        userId
      )
      .first();

  if (!row) {
    return {
      exists:
        false,

      settings:
        defaultSettings(),

      created_at:
        null,

      updated_at:
        null
    };
  }

  return {
    exists:
      true,

    settings: {
      show_system_messages:
        databaseBoolean(
          row.show_system_messages
        ),

      show_timestamps:
        databaseBoolean(
          row.show_timestamps
        ),

      emoji_picker_enabled:
        databaseBoolean(
          row.emoji_picker_enabled
        )
    },

    created_at:
      row.created_at,

    updated_at:
      row.updated_at
  };
}


/*
 * =====================================================
 * GET
 * =====================================================
 *
 * GET /api/chat/settings
 *
 * Gibt die persönlichen Chat-Einstellungen zurück.
 *
 * Wenn der Benutzer noch nie etwas geändert hat,
 * gelten automatisch:
 *
 * Systemmeldungen: AN
 * Zeitstempel:      AN
 * Emoji-Picker:     AN
 *
 * Dafür muss nicht sofort ein DB-Datensatz erzeugt
 * werden.
 * =====================================================
 */

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
        ok:
          false,

        error:
          "Du musst eingeloggt sein."
      }, 401);
    }

    const data =
      await loadSettings(
        env,
        user.id
      );

    return json({
      ok:
        true,

      user_id:
        user.id,

      settings:
        data.settings,

      created_at:
        data.created_at,

      updated_at:
        data.updated_at
    });

  } catch (error) {
    console.error(
      "GET /api/chat/settings error:",
      error
    );

    return json({
      ok:
        false,

      error:
        "Die Chat-Einstellungen konnten nicht geladen werden."
    }, 500);
  }
}


/*
 * =====================================================
 * PUT
 * =====================================================
 *
 * PUT /api/chat/settings
 *
 * Beispiel:
 *
 * {
 *   "show_system_messages": true,
 *   "show_timestamps": true,
 *   "emoji_picker_enabled": true
 * }
 *
 *
 * Es müssen NICHT immer alle Einstellungen
 * mitgeschickt werden.
 *
 * Beispiel:
 *
 * {
 *   "show_timestamps": false
 * }
 *
 * ändert ausschließlich die Zeitstempel.
 * =====================================================
 */

export async function onRequestPut(
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
        ok:
          false,

        error:
          "Du musst eingeloggt sein."
      }, 401);
    }

    let body;

    try {
      body =
        await request.json();

    } catch {
      return json({
        ok:
          false,

        error:
          "Ungültige Anfrage."
      }, 400);
    }


    /*
     * =================================================
     * AKTUELLE EINSTELLUNGEN
     * =================================================
     */

    const current =
      await loadSettings(
        env,
        user.id
      );

    let showSystemMessages =
      current.settings
        .show_system_messages;

    let showTimestamps =
      current.settings
        .show_timestamps;

    let emojiPickerEnabled =
      current.settings
        .emoji_picker_enabled;


    /*
     * =================================================
     * SYSTEMMELDUNGEN
     * =================================================
     */

    if (
      Object.prototype
        .hasOwnProperty.call(
          body,
          "show_system_messages"
        )
    ) {
      const parsed =
        parseBoolean(
          body.show_system_messages
        );

      if (
        parsed === null
      ) {
        return json({
          ok:
            false,

          error:
            "show_system_messages muss true oder false sein."
        }, 400);
      }

      showSystemMessages =
        parsed === 1;
    }


    /*
     * =================================================
     * ZEITSTEMPEL
     * =================================================
     */

    if (
      Object.prototype
        .hasOwnProperty.call(
          body,
          "show_timestamps"
        )
    ) {
      const parsed =
        parseBoolean(
          body.show_timestamps
        );

      if (
        parsed === null
      ) {
        return json({
          ok:
            false,

          error:
            "show_timestamps muss true oder false sein."
        }, 400);
      }

      showTimestamps =
        parsed === 1;
    }


    /*
     * =================================================
     * EMOJI PICKER
     * =================================================
     */

    if (
      Object.prototype
        .hasOwnProperty.call(
          body,
          "emoji_picker_enabled"
        )
    ) {
      const parsed =
        parseBoolean(
          body.emoji_picker_enabled
        );

      if (
        parsed === null
      ) {
        return json({
          ok:
            false,

          error:
            "emoji_picker_enabled muss true oder false sein."
        }, 400);
      }

      emojiPickerEnabled =
        parsed === 1;
    }


    /*
     * =================================================
     * MINDESTENS EINE BEKANNTE EINSTELLUNG?
     * =================================================
     */

    const hasKnownSetting =
      Object.prototype
        .hasOwnProperty.call(
          body,
          "show_system_messages"
        ) ||

      Object.prototype
        .hasOwnProperty.call(
          body,
          "show_timestamps"
        ) ||

      Object.prototype
        .hasOwnProperty.call(
          body,
          "emoji_picker_enabled"
        );

    if (
      !hasKnownSetting
    ) {
      return json({
        ok:
          false,

        error:
          "Es wurde keine gültige Chat-Einstellung übergeben."
      }, 400);
    }


    /*
     * =================================================
     * SAVE
     * =================================================
     */

    const now =
      Math.floor(
        Date.now() / 1000
      );

    /*
     * UPSERT:
     *
     * Existiert noch kein Datensatz, wird einer
     * angelegt.
     *
     * Existiert bereits einer, werden die Werte
     * aktualisiert.
     *
     * created_at bleibt beim Update unverändert.
     */

    await env.DB.prepare(`
      INSERT INTO chat_user_settings (
        user_id,
        show_system_messages,
        show_timestamps,
        emoji_picker_enabled,
        created_at,
        updated_at
      )

      VALUES (?, ?, ?, ?, ?, ?)

      ON CONFLICT(user_id)

      DO UPDATE SET
        show_system_messages =
          excluded.show_system_messages,

        show_timestamps =
          excluded.show_timestamps,

        emoji_picker_enabled =
          excluded.emoji_picker_enabled,

        updated_at =
          excluded.updated_at
    `)
      .bind(
        user.id,

        showSystemMessages
          ? 1
          : 0,

        showTimestamps
          ? 1
          : 0,

        emojiPickerEnabled
          ? 1
          : 0,

        now,
        now
      )
      .run();


    /*
     * =================================================
     * AKTUALISIERTEN DATENSATZ ZURÜCKGEBEN
     * =================================================
     */

    const updated =
      await loadSettings(
        env,
        user.id
      );

    return json({
      ok:
        true,

      user_id:
        user.id,

      settings:
        updated.settings,

      created_at:
        updated.created_at,

      updated_at:
        updated.updated_at
    });

  } catch (error) {
    console.error(
      "PUT /api/chat/settings error:",
      error
    );

    return json({
      ok:
        false,

      error:
        "Die Chat-Einstellungen konnten nicht gespeichert werden."
    }, 500);
  }
}


/*
 * =====================================================
 * POST
 * =====================================================
 *
 * Einstellungen werden ausschließlich mit PUT
 * geändert.
 * =====================================================
 */

export async function onRequestPost() {
  return json({
    ok:
      false,

    error:
      "Verwende PUT, um Chat-Einstellungen zu ändern."
  }, 405);
}


/*
 * =====================================================
 * DELETE
 * =====================================================
 *
 * DELETE setzt die persönlichen Einstellungen
 * wieder auf Standard zurück.
 *
 * Das ist praktisch, falls wir später im Frontend
 * einen Button 'Auf Standard zurücksetzen' anbieten.
 * =====================================================
 */

export async function onRequestDelete(
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
        ok:
          false,

        error:
          "Du musst eingeloggt sein."
      }, 401);
    }

    await env.DB.prepare(`
      DELETE FROM chat_user_settings

      WHERE user_id = ?
    `)
      .bind(
        user.id
      )
      .run();

    return json({
      ok:
        true,

      reset:
        true,

      settings:
        defaultSettings()
    });

  } catch (error) {
    console.error(
      "DELETE /api/chat/settings error:",
      error
    );

    return json({
      ok:
        false,

      error:
        "Die Chat-Einstellungen konnten nicht zurückgesetzt werden."
    }, 500);
  }
}
