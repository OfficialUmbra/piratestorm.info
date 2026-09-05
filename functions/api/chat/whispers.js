const MAX_ROOM_MEMBERS = 5;
const MAX_MESSAGE_LENGTH = 500;
const MAX_ROOM_NAME_LENGTH = 50;

const FLOOD_WINDOW_SECONDS = 10;
const FLOOD_MAX_MESSAGES = 5;

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

    if (key === name) {
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
 * HELPERS
 * =====================================================
 */

function isAdmin(user) {
  return Boolean(
    user &&
    user.role === "admin"
  );
}

function cleanText(value) {
  if (
    typeof value !==
    "string"
  ) {
    return "";
  }

  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

function toPositiveInt(value) {
  const number =
    Number(value);

  if (
    !Number.isInteger(number) ||
    number <= 0
  ) {
    return null;
  }

  return number;
}

function getServerCode(user) {
  if (
    user?.role ===
    "admin"
  ) {
    return "ADMIN";
  }

  const map = {
    "Deutschland 1":
      "DE1",

    "Europa 1":
      "EU1",

    "Europa 2":
      "EU2",

    "Europa 3":
      "EU3",

    "Europa 4":
      "EU4",

    "Arabien 1":
      "AR1",

    "Lateinamerika 1":
      "LA1",

    "USA 1":
      "USA1"
  };

  return (
    map[user?.server] ||
    user?.server ||
    ""
  );
}

/*
 * =====================================================
 * USERS
 * =====================================================
 */

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
    .bind(userId)
    .first();
}

/*
 * =====================================================
 * BAN
 * =====================================================
 */

async function cleanupExpiredBans(
  env
) {
  const now =
    Math.floor(
      Date.now() / 1000
    );

  await env.DB.prepare(`
    UPDATE chat_bans

    SET active = 0

    WHERE active = 1
      AND expires_at IS NOT NULL
      AND expires_at <= ?
  `)
    .bind(now)
    .run();
}

async function getActiveBan(
  env,
  userId
) {
  await cleanupExpiredBans(
    env
  );

  const now =
    Math.floor(
      Date.now() / 1000
    );

  return await env.DB.prepare(`
    SELECT
      id,
      user_id,
      reason,
      banned_at,
      expires_at

    FROM chat_bans

    WHERE user_id = ?
      AND active = 1
      AND (
        expires_at IS NULL
        OR expires_at > ?
      )

    ORDER BY
      banned_at DESC,
      id DESC

    LIMIT 1
  `)
    .bind(
      userId,
      now
    )
    .first();
}

async function rejectIfBanned(
  env,
  user
) {
  /*
   * Admin bleibt immun.
   */
  if (isAdmin(user)) {
    return null;
  }

  const ban =
    await getActiveBan(
      env,
      user.id
    );

  if (!ban) {
    return null;
  }

  const now =
    Math.floor(
      Date.now() / 1000
    );

  const permanent =
    ban.expires_at ===
    null;

  /*
   * Presence direkt entfernen.
   */
  try {
    await env.DB.prepare(`
      DELETE FROM chat_presence

      WHERE user_id = ?
    `)
      .bind(user.id)
      .run();

  } catch (error) {
    console.error(
      "Whisper ban presence cleanup:",
      error
    );
  }

  return json({
    ok:
      false,

    code:
      "CHAT_BANNED",

    error:
      "Du bist derzeit vom Chat ausgeschlossen.",

    banned:
      true,

    ban: {
      id:
        ban.id,

      reason:
        ban.reason || null,

      banned_at:
        ban.banned_at,

      expires_at:
        ban.expires_at,

      permanent,

      remaining_seconds:
        permanent
          ? null
          : Math.max(
              0,
              Number(
                ban.expires_at
              ) - now
            )
    }
  }, 403);
}

/*
 * =====================================================
 * BLOCK
 * =====================================================
 */

async function usersBlockEachOther(
  env,
  userA,
  userB
) {
  const row =
    await env.DB.prepare(`
      SELECT id

      FROM chat_blocks

      WHERE
        (
          blocker_id = ?
          AND blocked_id = ?
        )
        OR
        (
          blocker_id = ?
          AND blocked_id = ?
        )

      LIMIT 1
    `)
      .bind(
        userA,
        userB,
        userB,
        userA
      )
      .first();

  return Boolean(row);
}

/*
 * =====================================================
 * ROOM
 * =====================================================
 */

async function getRoom(
  env,
  roomId
) {
  return await env.DB.prepare(`
    SELECT
      id,
      created_by,
      name,
      created_at

    FROM whisper_rooms

    WHERE id = ?

    LIMIT 1
  `)
    .bind(roomId)
    .first();
}

async function isRoomMember(
  env,
  roomId,
  userId
) {
  const row =
    await env.DB.prepare(`
      SELECT
        room_id,
        user_id,
        joined_at

      FROM whisper_members

      WHERE room_id = ?
        AND user_id = ?

      LIMIT 1
    `)
      .bind(
        roomId,
        userId
      )
      .first();

  return Boolean(row);
}

async function getRoomMembers(
  env,
  roomId
) {
  const result =
    await env.DB.prepare(`
      SELECT
        u.id,
        u.username,
        u.server,
        u.role,
        wm.joined_at

      FROM whisper_members wm

      JOIN users u
        ON u.id =
          wm.user_id

      WHERE wm.room_id = ?

      ORDER BY
        wm.joined_at ASC,
        wm.user_id ASC
    `)
      .bind(roomId)
      .all();

  return (
    result.results || []
  );
}

function formatMember(
  member,
  room
) {
  return {
    id:
      member.id,

    username:
      member.username,

    server:
      member.server,

    server_code:
      getServerCode(
        member
      ),

    role:
      member.role,

    is_admin:
      member.role ===
      "admin",

    /*
     * V25:
     * Host/Krone.
     */
    is_host:
      Number(
        member.id
      ) ===
      Number(
        room.created_by
      ),

    joined_at:
      member.joined_at
  };
}

async function getPendingInviteCount(
  env,
  roomId
) {
  const row =
    await env.DB.prepare(`
      SELECT
        COUNT(*) AS total

      FROM whisper_invites

      WHERE room_id = ?
        AND status =
          'pending'
    `)
      .bind(roomId)
      .first();

  return Number(
    row?.total || 0
  );
}

async function getRoomMemberCount(
  env,
  roomId
) {
  const row =
    await env.DB.prepare(`
      SELECT
        COUNT(*) AS total

      FROM whisper_members

      WHERE room_id = ?
    `)
      .bind(roomId)
      .first();

  return Number(
    row?.total || 0
  );
}

/*
 * =====================================================
 * SYSTEM MESSAGE
 * =====================================================
 */

async function addWhisperSystemMessage(
  env,
  roomId,
  eventType,
  user,
  message
) {
  const now =
    Math.floor(
      Date.now() / 1000
    );

  await env.DB.prepare(`
    INSERT INTO whisper_system_messages (
      room_id,
      event_type,
      user_id,
      username,
      message,
      created_at
    )

    VALUES (?, ?, ?, ?, ?, ?)
  `)
    .bind(
      roomId,
      eventType,
      user?.id || null,
      user?.username || null,
      message,
      now
    )
    .run();

  return now;
}

/*
 * =====================================================
 * UNREAD COUNT
 * =====================================================
 *
 * Gezählt werden echte Whisper-Nachrichten.
 *
 * Eigene Nachrichten zählen nicht als ungelesen.
 *
 * whisper_read_state ist bereits vorhanden.
 * =====================================================
 */

async function getUnreadCount(
  env,
  roomId,
  userId
) {
  const state =
    await env.DB.prepare(`
      SELECT
        last_read_message_id

      FROM whisper_read_state

      WHERE room_id = ?
        AND user_id = ?

      LIMIT 1
    `)
      .bind(
        roomId,
        userId
      )
      .first();

  const lastRead =
    Number(
      state?.last_read_message_id ||
      0
    );

  const result =
    await env.DB.prepare(`
      SELECT
        COUNT(*) AS total

      FROM whisper_messages

      WHERE room_id = ?
        AND id > ?
        AND user_id != ?
        AND deleted_at IS NULL
    `)
      .bind(
        roomId,
        lastRead,
        userId
      )
      .first();

  return Number(
    result?.total || 0
  );
}

/*
 * =====================================================
 * ROOM RESPONSE
 * =====================================================
 */

async function getRoomResponse(
  env,
  roomId,
  currentUserId = null
) {
  const room =
    await getRoom(
      env,
      roomId
    );

  if (!room) {
    return null;
  }

  const members =
    await getRoomMembers(
      env,
      roomId
    );

  const pendingInvites =
    await getPendingInviteCount(
      env,
      roomId
    );

  let unread = 0;

  if (currentUserId) {
    unread =
      await getUnreadCount(
        env,
        roomId,
        currentUserId
      );
  }

  return {
    id:
      room.id,

    name:
      room.name || null,

    created_by:
      room.created_by,

    created_at:
      room.created_at,

    pending_invites:
      pendingInvites,

    unread,

    members:
      members.map(
        member =>
          formatMember(
            member,
            room
          )
      )
  };
}

/*
 * =====================================================
 * FLOOD / DUPLICATE
 * =====================================================
 */

async function checkFloodProtection(
  env,
  userId,
  roomId,
  message
) {
  const now =
    Math.floor(
      Date.now() / 1000
    );

  const flood =
    await env.DB.prepare(`
      SELECT
        COUNT(*) AS total

      FROM whisper_messages

      WHERE user_id = ?
        AND created_at >= ?
        AND deleted_at IS NULL
    `)
      .bind(
        userId,
        now -
        FLOOD_WINDOW_SECONDS
      )
      .first();

  if (
    Number(
      flood?.total || 0
    ) >=
    FLOOD_MAX_MESSAGES
  ) {
    return {
      ok:
        false,

      code:
        "FLOOD_LIMIT",

      error:
        "Du schreibst zu schnell. Bitte warte einen Moment."
    };
  }

  const previous =
    await env.DB.prepare(`
      SELECT
        original_message,
        message

      FROM whisper_messages

      WHERE room_id = ?
        AND user_id = ?
        AND deleted_at IS NULL

      ORDER BY
        created_at DESC,
        id DESC

      LIMIT 1
    `)
      .bind(
        roomId,
        userId
      )
      .first();

  if (previous) {
    const oldMessage =
      cleanText(
        previous.original_message ||
        previous.message
      )
        .toLocaleLowerCase();

    const newMessage =
      cleanText(
        message
      )
        .toLocaleLowerCase();

    if (
      oldMessage &&
      oldMessage ===
      newMessage
    ) {
      return {
        ok:
          false,

        code:
          "DUPLICATE_MESSAGE",

        error:
          "Bitte sende nicht mehrfach dieselbe Nachricht."
      };
    }
  }

  return {
    ok:
      true
  };
}

/*
 * =====================================================
 * INVITE TARGET CHECK
 * =====================================================
 */

async function validateInviteTarget(
  env,
  user,
  targetUserId
) {
  const target =
    await getUserById(
      env,
      targetUserId
    );

  if (!target) {
    return {
      ok:
        false,

      error:
        "Spieler wurde nicht gefunden.",

      status:
        404
    };
  }

  if (
    Number(target.id) ===
    Number(user.id)
  ) {
    return {
      ok:
        false,

      error:
        "Du kannst dich nicht selbst einladen.",

      status:
        400
    };
  }

  if (
    target.server !==
    user.server
  ) {
    return {
      ok:
        false,

      error:
        `${target.username} spielt auf einem anderen Server.`,

      status:
        403
    };
  }

  if (
    !isAdmin(user) &&
    !isAdmin(target)
  ) {
    const blocked =
      await usersBlockEachOther(
        env,
        user.id,
        target.id
      );

    if (blocked) {
      return {
        ok:
          false,

        error:
          `Mit ${target.username} ist wegen einer Blockierung kein Whisper möglich.`,

        status:
          403
      };
    }
  }

  /*
   * Gebannte Zielspieler nicht neu einladen.
   */
  if (!isAdmin(target)) {
    const targetBan =
      await getActiveBan(
        env,
        target.id
      );

    if (targetBan) {
      return {
        ok:
          false,

        error:
          `${target.username} ist derzeit vom Chat ausgeschlossen.`,

        status:
          403
      };
    }
  }

  return {
    ok:
      true,

    target
  };
}

/*
 * =====================================================
 * LOAD NORMAL MESSAGES
 * =====================================================
 */

async function loadWhisperMessages(
  env,
  roomId,
  limit
) {
  const result =
    await env.DB.prepare(`
      SELECT
        wm.id,
        wm.room_id,
        wm.user_id,
        wm.message,
        wm.original_message,
        wm.reply_to,
        wm.created_at,
        wm.deleted_at,

        u.username,
        u.server,
        u.role,

        reply_message.message
          AS reply_message,

        reply_user.username
          AS reply_username

      FROM whisper_messages wm

      JOIN users u
        ON u.id =
          wm.user_id

      LEFT JOIN whisper_messages reply_message
        ON reply_message.id =
          wm.reply_to
        AND reply_message.deleted_at
          IS NULL

      LEFT JOIN users reply_user
        ON reply_user.id =
          reply_message.user_id

      WHERE wm.room_id = ?

      ORDER BY
        wm.created_at DESC,
        wm.id DESC

      LIMIT ?
    `)
      .bind(
        roomId,
        limit
      )
      .all();

  return (
    result.results || []
  ).map(
    item => ({
      item_type:
        "message",

      type:
        "message",

      id:
        item.id,

      sort_id:
        Number(
          item.id
        ),

      room_id:
        item.room_id,

      user: {
        id:
          item.user_id,

        username:
          item.username,

        server:
          item.server,

        server_code:
          getServerCode(
            item
          ),

        role:
          item.role,

        is_admin:
          item.role ===
          "admin"
      },

      message:
        item.deleted_at
          ? null
          : item.message,

      original_message:
        item.deleted_at
          ? null
          : (
              item.original_message ||
              item.message
            ),

      reply_to:
        item.reply_to
          ? {
              id:
                item.reply_to,

              username:
                item.reply_username ||
                null,

              message:
                item.reply_message ||
                null
            }
          : null,

      created_at:
        item.created_at,

      deleted:
        Boolean(
          item.deleted_at
        )
    })
  );
}

/*
 * =====================================================
 * LOAD SYSTEM MESSAGES
 * =====================================================
 */

async function loadWhisperSystemMessages(
  env,
  roomId,
  limit
) {
  const result =
    await env.DB.prepare(`
      SELECT
        id,
        room_id,
        event_type,
        user_id,
        username,
        message,
        created_at

      FROM whisper_system_messages

      WHERE room_id = ?

      ORDER BY
        created_at DESC,
        id DESC

      LIMIT ?
    `)
      .bind(
        roomId,
        limit
      )
      .all();

  return (
    result.results || []
  ).map(
    item => ({
      item_type:
        "system",

      type:
        "system",

      system:
        true,

      id:
        `system-${item.id}`,

      system_id:
        item.id,

      sort_id:
        Number(
          item.id
        ),

      room_id:
        item.room_id,

      event_type:
        item.event_type,

      user_id:
        item.user_id,

      username:
        item.username,

      message:
        item.message,

      created_at:
        item.created_at
    })
  );
}

/*
 * =====================================================
 * MERGE ITEMS
 * =====================================================
 */

function mergeItems(
  normalMessages,
  systemMessages,
  limit
) {
  return [
    ...normalMessages,
    ...systemMessages
  ]
    .sort(
      (a, b) => {
        const timeDiff =
          Number(
            a.created_at
          ) -
          Number(
            b.created_at
          );

        if (timeDiff !== 0) {
          return timeDiff;
        }

        if (
          a.item_type !==
          b.item_type
        ) {
          return a.item_type ===
            "message"
            ? -1
            : 1;
        }

        return (
          Number(
            a.sort_id || 0
          ) -
          Number(
            b.sort_id || 0
          )
        );
      }
    )
    .slice(
      -limit
    );
}

/*
 * =====================================================
 * GET
 * =====================================================
 *
 * GET /api/chat/whispers
 *
 * -> eigene Räume
 * -> unread counts
 * -> pending invites
 *
 *
 * GET /api/chat/whispers?room_id=123
 *
 * -> Raum
 * -> Mitglieder
 * -> normale Nachrichten
 * -> Systemmeldungen
 *
 * Kein Admin-Bypass für private Whispers.
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

    const banned =
      await rejectIfBanned(
        env,
        user
      );

    if (banned) {
      return banned;
    }

    const url =
      new URL(
        request.url
      );

    const roomId =
      toPositiveInt(
        url.searchParams.get(
          "room_id"
        )
      );

    /*
     * =================================================
     * ROOM LIST
     * =================================================
     */
    if (!roomId) {
      const roomsResult =
        await env.DB.prepare(`
          SELECT
            wr.id,
            wr.created_by,
            wr.name,
            wr.created_at,
            wm.joined_at

          FROM whisper_rooms wr

          JOIN whisper_members wm
            ON wm.room_id =
              wr.id

          WHERE wm.user_id = ?

          ORDER BY
            wr.created_at DESC,
            wr.id DESC
        `)
          .bind(
            user.id
          )
          .all();

      const rooms = [];

      for (
        const row
        of roomsResult.results ||
        []
      ) {
        const room =
          await getRoomResponse(
            env,
            row.id,
            user.id
          );

        if (room) {
          rooms.push(
            room
          );
        }
      }

      /*
       * Pending invitations.
       */
      const invitesResult =
        await env.DB.prepare(`
          SELECT
            wi.id,
            wi.room_id,
            wi.inviter_id,
            wi.created_at,

            inviter.username
              AS inviter_username,

            inviter.server
              AS inviter_server,

            inviter.role
              AS inviter_role,

            wr.name
              AS room_name

          FROM whisper_invites wi

          JOIN users inviter
            ON inviter.id =
              wi.inviter_id

          JOIN whisper_rooms wr
            ON wr.id =
              wi.room_id

          WHERE wi.invited_user_id = ?
            AND wi.status =
              'pending'

          ORDER BY
            wi.created_at DESC,
            wi.id DESC
        `)
          .bind(
            user.id
          )
          .all();

      const invites =
        (
          invitesResult.results ||
          []
        ).map(
          invite => ({
            id:
              invite.id,

            room_id:
              invite.room_id,

            room_name:
              invite.room_name ||
              null,

            inviter: {
              id:
                invite.inviter_id,

              username:
                invite.inviter_username,

              server:
                invite.inviter_server,

              server_code:
                getServerCode({
                  server:
                    invite.inviter_server,

                  role:
                    invite.inviter_role
                }),

              role:
                invite.inviter_role,

              is_admin:
                invite.inviter_role ===
                "admin"
            },

            created_at:
              invite.created_at
          })
        );

      return json({
        ok:
          true,

        current_user: {
          id:
            user.id,

          username:
            user.username,

          server:
            user.server,

          server_code:
            getServerCode(
              user
            ),

          role:
            user.role,

          is_admin:
            isAdmin(user)
        },

        rooms,

        invites,

        total_unread:
          rooms.reduce(
            (
              total,
              room
            ) =>
              total +
              Number(
                room.unread ||
                0
              ),
            0
          ),

        pending_invite_count:
          invites.length
      });
    }

    /*
     * =================================================
     * SINGLE ROOM
     * =================================================
     */

    const room =
      await getRoom(
        env,
        roomId
      );

    if (!room) {
      return json({
        ok:
          false,

        error:
          "Whisper-Chat wurde nicht gefunden."
      }, 404);
    }

    /*
     * Wichtig:
     * KEIN Admin-Bypass.
     */
    const membership =
      await isRoomMember(
        env,
        roomId,
        user.id
      );

    if (!membership) {
      return json({
        ok:
          false,

        error:
          "Du bist kein Mitglied dieses Whisper-Chats."
      }, 403);
    }

    let limit =
      Number(
        url.searchParams.get(
          "limit"
        ) || 100
      );

    if (
      !Number.isInteger(limit) ||
      limit < 1
    ) {
      limit = 100;
    }

    limit =
      Math.min(
        limit,
        200
      );

    const roomResponse =
      await getRoomResponse(
        env,
        roomId,
        user.id
      );

    const [
      normalMessages,
      systemMessages
    ] =
      await Promise.all([
        loadWhisperMessages(
          env,
          roomId,
          limit
        ),

        loadWhisperSystemMessages(
          env,
          roomId,
          limit
        )
      ]);

    const messages =
      mergeItems(
        normalMessages,
        systemMessages,
        limit
      );

    return json({
      ok:
        true,

      room:
        roomResponse,

      messages,

      items:
        messages
    });

  } catch (error) {
    console.error(
      "GET /api/chat/whispers error:",
      error
    );

    return json({
      ok:
        false,

      error:
        "Whisper-Daten konnten nicht geladen werden."
    }, 500);
  }
}

/*
 * =====================================================
 * POST
 * =====================================================
 *
 * V25 ACTIONS:
 *
 * create
 * send
 * invite
 * rename
 * =====================================================
 */

export async function onRequestPost(
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

    const banned =
      await rejectIfBanned(
        env,
        user
      );

    if (banned) {
      return banned;
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

    const action =
      cleanText(
        body.action
      )
        .toLowerCase();

    /*
     * =================================================
     * CREATE
     * =================================================
     */

    if (
      action ===
      "create"
    ) {
      const name =
        cleanText(
          body.name
        );

      if (
        name.length >
        MAX_ROOM_NAME_LENGTH
      ) {
        return json({
          ok:
            false,

          error:
            `Der Gruppenname darf maximal ${MAX_ROOM_NAME_LENGTH} Zeichen lang sein.`
        }, 400);
      }

      if (
        !Array.isArray(
          body.invited_user_ids
        )
      ) {
        return json({
          ok:
            false,

          error:
            "Es muss mindestens ein Spieler eingeladen werden."
        }, 400);
      }

      const invitedIds =
        [
          ...new Set(
            body
              .invited_user_ids
              .map(
                toPositiveInt
              )
              .filter(Boolean)
          )
        ].filter(
          id =>
            Number(id) !==
            Number(user.id)
        );

      if (
        invitedIds.length <
          1 ||
        invitedIds.length >
          4
      ) {
        return json({
          ok:
            false,

          error:
            "Ein Whisper-Chat muss insgesamt 2 bis 5 Spieler haben."
        }, 400);
      }

      const invitedUsers =
        [];

      for (
        const targetId
        of invitedIds
      ) {
        const validation =
          await validateInviteTarget(
            env,
            user,
            targetId
          );

        if (!validation.ok) {
          return json({
            ok:
              false,

            error:
              validation.error
          }, validation.status);
        }

        invitedUsers.push(
          validation.target
        );
      }

      const now =
        Math.floor(
          Date.now() / 1000
        );

      const roomInsert =
        await env.DB.prepare(`
          INSERT INTO whisper_rooms (
            created_by,
            name,
            created_at
          )

          VALUES (?, ?, ?)
        `)
          .bind(
            user.id,
            name || null,
            now
          )
          .run();

      const roomId =
        roomInsert?.meta
          ?.last_row_id;

      if (!roomId) {
        return json({
          ok:
            false,

          error:
            "Whisper-Chat konnte nicht erstellt werden."
        }, 500);
      }

      /*
       * Creator = erster Host.
       */
      await env.DB.prepare(`
        INSERT INTO whisper_members (
          room_id,
          user_id,
          joined_at
        )

        VALUES (?, ?, ?)
      `)
        .bind(
          roomId,
          user.id,
          now
        )
        .run();

      /*
       * Invites.
       */
      for (
        const target
        of invitedUsers
      ) {
        await env.DB.prepare(`
          INSERT INTO whisper_invites (
            room_id,
            inviter_id,
            invited_user_id,
            status,
            created_at
          )

          VALUES (
            ?,
            ?,
            ?,
            'pending',
            ?
          )
        `)
          .bind(
            roomId,
            user.id,
            target.id,
            now
          )
          .run();
      }

      const roomResponse =
        await getRoomResponse(
          env,
          roomId,
          user.id
        );

      return json({
        ok:
          true,

        room:
          roomResponse,

        invited_users:
          invitedUsers.map(
            target => ({
              id:
                target.id,

              username:
                target.username,

              server:
                target.server,

              server_code:
                getServerCode(
                  target
                ),

              role:
                target.role,

              is_admin:
                isAdmin(
                  target
                )
            })
          )
      }, 201);
    }

    /*
     * =================================================
     * SEND MESSAGE
     * =================================================
     */

    if (
      action ===
      "send"
    ) {
      const roomId =
        toPositiveInt(
          body.room_id
        );

      if (!roomId) {
        return json({
          ok:
            false,

          error:
            "Ungültiger Whisper-Chat."
        }, 400);
      }

      const membership =
        await isRoomMember(
          env,
          roomId,
          user.id
        );

      if (!membership) {
        return json({
          ok:
            false,

          error:
            "Du bist kein Mitglied dieses Whisper-Chats."
        }, 403);
      }

      const room =
        await getRoom(
          env,
          roomId
        );

      if (!room) {
        return json({
          ok:
            false,

          error:
            "Whisper-Chat wurde nicht gefunden."
        }, 404);
      }

      const message =
        cleanText(
          body.message
        );

      if (!message) {
        return json({
          ok:
            false,

          error:
            "Die Nachricht darf nicht leer sein."
        }, 400);
      }

      if (
        message.length >
        MAX_MESSAGE_LENGTH
      ) {
        return json({
          ok:
            false,

          error:
            `Die Nachricht darf maximal ${MAX_MESSAGE_LENGTH} Zeichen enthalten.`
        }, 400);
      }

      /*
       * Alle Mitglieder müssen weiterhin auf
       * demselben Server liegen.
       */
      const members =
        await getRoomMembers(
          env,
          roomId
        );

      for (
        const member
        of members
      ) {
        if (
          member.server !==
          user.server
        ) {
          return json({
            ok:
              false,

            error:
              "Dieser Whisper-Chat enthält eine ungültige Serverkombination."
          }, 403);
        }

        if (
          Number(
            member.id
          ) ===
          Number(
            user.id
          )
        ) {
          continue;
        }

        if (
          isAdmin(user) ||
          isAdmin(member)
        ) {
          continue;
        }

        const blocked =
          await usersBlockEachOther(
            env,
            user.id,
            member.id
          );

        if (blocked) {
          return json({
            ok:
              false,

            error:
              `Eine Nachricht an ${member.username} ist wegen einer Blockierung nicht möglich.`
          }, 403);
        }
      }

      /*
       * Flood protection.
       */
      const flood =
        await checkFloodProtection(
          env,
          user.id,
          roomId,
          message
        );

      if (!flood.ok) {
        return json({
          ok:
            false,

          code:
            flood.code,

          error:
            flood.error
        }, 429);
      }

      /*
       * Reply.
       */
      let replyTo =
        null;

      if (
        body.reply_to !==
          null &&
        body.reply_to !==
          undefined &&
        body.reply_to !==
          ""
      ) {
        replyTo =
          toPositiveInt(
            body.reply_to
          );

        if (!replyTo) {
          return json({
            ok:
              false,

            error:
              "Ungültige Antwort-Nachricht."
          }, 400);
        }

        const reply =
          await env.DB.prepare(`
            SELECT id

            FROM whisper_messages

            WHERE id = ?
              AND room_id = ?
              AND deleted_at IS NULL

            LIMIT 1
          `)
            .bind(
              replyTo,
              roomId
            )
            .first();

        if (!reply) {
          return json({
            ok:
              false,

            error:
              "Die Nachricht, auf die du antworten möchtest, wurde nicht gefunden."
          }, 404);
        }
      }

      const now =
        Math.floor(
          Date.now() / 1000
        );

      const insert =
        await env.DB.prepare(`
          INSERT INTO whisper_messages (
            room_id,
            user_id,
            message,
            original_message,
            reply_to,
            created_at
          )

          VALUES (?, ?, ?, ?, ?, ?)
        `)
          .bind(
            roomId,
            user.id,
            message,
            message,
            replyTo,
            now
          )
          .run();

      const messageId =
        insert?.meta
          ?.last_row_id ||
        null;

      /*
       * Eigene Nachricht direkt gelesen.
       */
      if (messageId) {
        await env.DB.prepare(`
          INSERT INTO whisper_read_state (
            room_id,
            user_id,
            last_read_message_id,
            updated_at
          )

          VALUES (?, ?, ?, ?)

          ON CONFLICT(
            room_id,
            user_id
          )

          DO UPDATE SET
            last_read_message_id =
              excluded.last_read_message_id,

            updated_at =
              excluded.updated_at
        `)
          .bind(
            roomId,
            user.id,
            messageId,
            now
          )
          .run();
      }

      return json({
        ok:
          true,

        message: {
          item_type:
            "message",

          type:
            "message",

          id:
            messageId,

          room_id:
            roomId,

          user: {
            id:
              user.id,

            username:
              user.username,

            server:
              user.server,

            server_code:
              getServerCode(
                user
              ),

            role:
              user.role,

            is_admin:
              isAdmin(user)
          },

          message,

          reply_to:
            replyTo,

          created_at:
            now
        }
      }, 201);
    }

    /*
     * =================================================
     * INVITE INTO EXISTING ROOM
     * =================================================
     *
     * Nur Host.
     *
     * {
     *   action: "invite",
     *   room_id: 12,
     *   invited_user_ids: [7, 8]
     * }
     * =================================================
     */

    if (
      action ===
      "invite"
    ) {
      const roomId =
        toPositiveInt(
          body.room_id
        );

      if (!roomId) {
        return json({
          ok:
            false,

          error:
            "Ungültiger Whisper-Chat."
        }, 400);
      }

      const room =
        await getRoom(
          env,
          roomId
        );

      if (!room) {
        return json({
          ok:
            false,

          error:
            "Whisper-Chat wurde nicht gefunden."
        }, 404);
      }

      const member =
        await isRoomMember(
          env,
          roomId,
          user.id
        );

      if (!member) {
        return json({
          ok:
            false,

          error:
            "Du bist kein Mitglied dieses Whisper-Chats."
        }, 403);
      }

      /*
       * Nur Host darf neue Spieler einladen.
       */
      if (
        Number(
          room.created_by
        ) !==
        Number(
          user.id
        )
      ) {
        return json({
          ok:
            false,

          error:
            "Nur der Host kann weitere Spieler einladen."
        }, 403);
      }

      if (
        !Array.isArray(
          body.invited_user_ids
        )
      ) {
        return json({
          ok:
            false,

          error:
            "Es wurde kein Spieler ausgewählt."
        }, 400);
      }

      const inviteIds =
        [
          ...new Set(
            body
              .invited_user_ids
              .map(
                toPositiveInt
              )
              .filter(Boolean)
          )
        ];

      if (
        inviteIds.length <
        1
      ) {
        return json({
          ok:
            false,

          error:
            "Es wurde kein Spieler ausgewählt."
        }, 400);
      }

      const memberCount =
        await getRoomMemberCount(
          env,
          roomId
        );

      const pendingCount =
        await getPendingInviteCount(
          env,
          roomId
        );

      const freeSlots =
        MAX_ROOM_MEMBERS -
        memberCount -
        pendingCount;

      if (
        freeSlots <= 0
      ) {
        return json({
          ok:
            false,

          error:
            "Dieser Whisper-Chat ist bereits voll oder alle freien Plätze sind reserviert."
        }, 409);
      }

      if (
        inviteIds.length >
        freeSlots
      ) {
        return json({
          ok:
            false,

          error:
            `Du kannst noch maximal ${freeSlots} Spieler einladen.`
        }, 409);
      }

      const invitedUsers =
        [];

      for (
        const targetId
        of inviteIds
      ) {
        const validation =
          await validateInviteTarget(
            env,
            user,
            targetId
          );

        if (!validation.ok) {
          return json({
            ok:
              false,

            error:
              validation.error
          }, validation.status);
        }

        const target =
          validation.target;

        /*
         * Bereits Mitglied?
         */
        const alreadyMember =
          await isRoomMember(
            env,
            roomId,
            target.id
          );

        if (alreadyMember) {
          return json({
            ok:
              false,

            error:
              `${target.username} ist bereits Mitglied dieses Whisper-Chats.`
          }, 409);
        }

        /*
         * Bereits pending?
         */
        const pending =
          await env.DB.prepare(`
            SELECT id

            FROM whisper_invites

            WHERE room_id = ?
              AND invited_user_id = ?
              AND status =
                'pending'

            LIMIT 1
          `)
            .bind(
              roomId,
              target.id
            )
            .first();

        if (pending) {
          return json({
            ok:
              false,

            error:
              `${target.username} wurde bereits eingeladen.`
          }, 409);
        }

        invitedUsers.push(
          target
        );
      }

      const now =
        Math.floor(
          Date.now() / 1000
        );

      for (
        const target
        of invitedUsers
      ) {
        await env.DB.prepare(`
          INSERT INTO whisper_invites (
            room_id,
            inviter_id,
            invited_user_id,
            status,
            created_at
          )

          VALUES (
            ?,
            ?,
            ?,
            'pending',
            ?
          )
        `)
          .bind(
            roomId,
            user.id,
            target.id,
            now
          )
          .run();
      }

      return json({
        ok:
          true,

        room_id:
          roomId,

        invited_users:
          invitedUsers.map(
            target => ({
              id:
                target.id,

              username:
                target.username,

              server:
                target.server,

              server_code:
                getServerCode(
                  target
                )
            })
          )
      });
    }

    /*
     * =================================================
     * RENAME
     * =================================================
     *
     * Nur Host.
     *
     * {
     *   action: "rename",
     *   room_id: 12,
     *   name: "Piratencrew"
     * }
     * =================================================
     */

    if (
      action ===
      "rename"
    ) {
      const roomId =
        toPositiveInt(
          body.room_id
        );

      if (!roomId) {
        return json({
          ok:
            false,

          error:
            "Ungültiger Whisper-Chat."
        }, 400);
      }

      const room =
        await getRoom(
          env,
          roomId
        );

      if (!room) {
        return json({
          ok:
            false,

          error:
            "Whisper-Chat wurde nicht gefunden."
        }, 404);
      }

      const member =
        await isRoomMember(
          env,
          roomId,
          user.id
        );

      if (!member) {
        return json({
          ok:
            false,

          error:
            "Du bist kein Mitglied dieses Whisper-Chats."
        }, 403);
      }

      if (
        Number(
          room.created_by
        ) !==
        Number(
          user.id
        )
      ) {
        return json({
          ok:
            false,

          error:
            "Nur der Host kann den Whisper-Chat umbenennen."
        }, 403);
      }

      const name =
        cleanText(
          body.name
        );

      if (!name) {
        return json({
          ok:
            false,

          error:
            "Der Name darf nicht leer sein."
        }, 400);
      }

      if (
        name.length >
        MAX_ROOM_NAME_LENGTH
      ) {
        return json({
          ok:
            false,

          error:
            `Der Gruppenname darf maximal ${MAX_ROOM_NAME_LENGTH} Zeichen lang sein.`
        }, 400);
      }

      if (
        room.name ===
        name
      ) {
        return json({
          ok:
            true,

          unchanged:
            true,

          room:
            await getRoomResponse(
              env,
              roomId,
              user.id
            )
        });
      }

      await env.DB.prepare(`
        UPDATE whisper_rooms

        SET name = ?

        WHERE id = ?
      `)
        .bind(
          name,
          roomId
        )
        .run();

      await addWhisperSystemMessage(
        env,
        roomId,
        "rename",
        user,
        `${user.username} hat den Flüsterchat in „${name}“ umbenannt.`
      );

      return json({
        ok:
          true,

        room:
          await getRoomResponse(
            env,
            roomId,
            user.id
          )
      });
    }

    return json({
      ok:
        false,

      error:
        "Ungültige Whisper-Aktion."
    }, 400);

  } catch (error) {
    console.error(
      "POST /api/chat/whispers error:",
      error
    );

    return json({
      ok:
        false,

      error:
        "Whisper-Aktion konnte nicht ausgeführt werden."
    }, 500);
  }
}

/*
 * =====================================================
 * PUT
 * =====================================================
 *
 * Einladung akzeptieren / ablehnen.
 *
 * {
 *   invite_id: 12,
 *   response: "accepted"
 * }
 *
 * oder:
 *
 * {
 *   invite_id: 12,
 *   response: "declined"
 * }
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

    const banned =
      await rejectIfBanned(
        env,
        user
      );

    if (banned) {
      return banned;
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

    const inviteId =
      toPositiveInt(
        body.invite_id
      );

    const response =
      cleanText(
        body.response
      )
        .toLowerCase();

    if (!inviteId) {
      return json({
        ok:
          false,

        error:
          "Ungültige Einladung."
      }, 400);
    }

    if (
      response !==
        "accepted" &&
      response !==
        "declined"
    ) {
      return json({
        ok:
          false,

        error:
          "Ungültige Antwort auf die Einladung."
      }, 400);
    }

    const invite =
      await env.DB.prepare(`
        SELECT
          wi.id,
          wi.room_id,
          wi.inviter_id,
          wi.invited_user_id,
          wi.status,

          inviter.username
            AS inviter_username,

          inviter.server
            AS inviter_server,

          inviter.role
            AS inviter_role

        FROM whisper_invites wi

        JOIN users inviter
          ON inviter.id =
            wi.inviter_id

        WHERE wi.id = ?
          AND wi.invited_user_id = ?

        LIMIT 1
      `)
        .bind(
          inviteId,
          user.id
        )
        .first();

    if (!invite) {
      return json({
        ok:
          false,

        error:
          "Einladung wurde nicht gefunden."
      }, 404);
    }

    if (
      invite.status !==
      "pending"
    ) {
      return json({
        ok:
          false,

        error:
          "Diese Einladung wurde bereits beantwortet."
      }, 409);
    }

    /*
     * =================================================
     * DECLINE
     * =================================================
     */

    if (
      response ===
      "declined"
    ) {
      await env.DB.prepare(`
        UPDATE whisper_invites

        SET status =
          'declined'

        WHERE id = ?
          AND invited_user_id = ?
          AND status =
            'pending'
      `)
        .bind(
          inviteId,
          user.id
        )
        .run();

      return json({
        ok:
          true,

        invite_id:
          inviteId,

        status:
          "declined"
      });
    }

    /*
     * =================================================
     * ACCEPT
     * =================================================
     */

    const room =
      await getRoom(
        env,
        invite.room_id
      );

    if (!room) {
      return json({
        ok:
          false,

        error:
          "Der Whisper-Chat existiert nicht mehr."
      }, 404);
    }

    /*
     * Noch immer gleicher Server.
     */
    if (
      invite.inviter_server !==
      user.server
    ) {
      return json({
        ok:
          false,

        error:
          "Dieser Whisper-Chat gehört nicht zu deinem Server."
      }, 403);
    }

    /*
     * Blockierungen erneut prüfen.
     */
    if (
      !isAdmin(user) &&
      invite.inviter_role !==
        "admin"
    ) {
      const blocked =
        await usersBlockEachOther(
          env,
          user.id,
          invite.inviter_id
        );

      if (blocked) {
        return json({
          ok:
            false,

          error:
            "Die Einladung kann wegen einer Blockierung nicht angenommen werden."
        }, 403);
      }
    }

    /*
     * Alle bestehenden Mitglieder ebenfalls prüfen.
     */
    const members =
      await getRoomMembers(
        env,
        invite.room_id
      );

    for (
      const member
      of members
    ) {
      if (
        member.server !==
        user.server
      ) {
        return json({
          ok:
            false,

          error:
            "Dieser Whisper-Chat gehört nicht zu deinem Server."
        }, 403);
      }

      if (
        isAdmin(user) ||
        isAdmin(member)
      ) {
        continue;
      }

      const blocked =
        await usersBlockEachOther(
          env,
          user.id,
          member.id
        );

      if (blocked) {
        return json({
          ok:
            false,

          error:
            `Der Whisper kann wegen einer Blockierung mit ${member.username} nicht betreten werden.`
        }, 403);
      }
    }

    const memberCount =
      await getRoomMemberCount(
        env,
        invite.room_id
      );

    if (
      memberCount >=
      MAX_ROOM_MEMBERS
    ) {
      return json({
        ok:
          false,

        error:
          "Dieser Whisper-Chat ist bereits voll."
      }, 409);
    }

    const now =
      Math.floor(
        Date.now() / 1000
      );

    await env.DB.prepare(`
      INSERT OR IGNORE
      INTO whisper_members (
        room_id,
        user_id,
        joined_at
      )

      VALUES (?, ?, ?)
    `)
      .bind(
        invite.room_id,
        user.id,
        now
      )
      .run();

    await env.DB.prepare(`
      UPDATE whisper_invites

      SET status =
        'accepted'

      WHERE id = ?
        AND invited_user_id = ?
        AND status =
          'pending'
    `)
      .bind(
        inviteId,
        user.id
      )
      .run();

    /*
     * V25 JOIN SYSTEM MESSAGE
     */
    await addWhisperSystemMessage(
      env,
      invite.room_id,
      "join",
      user,
      `${user.username} ist dem Flüsterchat beigetreten.`
    );

    const acceptedRoom =
      await getRoomResponse(
        env,
        invite.room_id,
        user.id
      );

    return json({
      ok:
        true,

      invite_id:
        inviteId,

      status:
        "accepted",

      room:
        acceptedRoom
    });

  } catch (error) {
    console.error(
      "PUT /api/chat/whispers error:",
      error
    );

    return json({
      ok:
        false,

      error:
        "Die Whisper-Einladung konnte nicht verarbeitet werden."
    }, 500);
  }
}

/*
 * =====================================================
 * DELETE
 * =====================================================
 *
 * Whisper verlassen/schließen.
 *
 * DELETE /api/chat/whispers?room_id=123
 *
 *
 * WICHTIG:
 *
 * Auch ein gebannter Spieler darf einen Whisper
 * verlassen.
 *
 * Daher hier absichtlich KEIN Ban-Check.
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

    const url =
      new URL(
        request.url
      );

    const roomId =
      toPositiveInt(
        url.searchParams.get(
          "room_id"
        )
      );

    if (!roomId) {
      return json({
        ok:
          false,

        error:
          "Ungültiger Whisper-Chat."
      }, 400);
    }

    const room =
      await getRoom(
        env,
        roomId
      );

    if (!room) {
      return json({
        ok:
          false,

        error:
          "Whisper-Chat wurde nicht gefunden."
      }, 404);
    }

    const membership =
      await isRoomMember(
        env,
        roomId,
        user.id
      );

    if (!membership) {
      return json({
        ok:
          false,

        error:
          "Du bist kein Mitglied dieses Whisper-Chats."
      }, 403);
    }

    /*
     * Erst Leave-Systemmeldung anlegen.
     *
     * Dadurch sehen die verbleibenden Mitglieder:
     *
     * "X hat den Flüsterchat verlassen."
     */
    await addWhisperSystemMessage(
      env,
      roomId,
      "leave",
      user,
      `${user.username} hat den Flüsterchat verlassen.`
    );

    /*
     * Mitglied entfernen.
     */
    await env.DB.prepare(`
      DELETE FROM whisper_members

      WHERE room_id = ?
        AND user_id = ?
    `)
      .bind(
        roomId,
        user.id
      )
      .run();

    /*
     * Read state entfernen.
     */
    await env.DB.prepare(`
      DELETE FROM whisper_read_state

      WHERE room_id = ?
        AND user_id = ?
    `)
      .bind(
        roomId,
        user.id
      )
      .run();

    /*
     * Eigene offene Einladung schließen.
     */
    await env.DB.prepare(`
      UPDATE whisper_invites

      SET status =
        'declined'

      WHERE room_id = ?
        AND invited_user_id = ?
        AND status =
          'pending'
    `)
      .bind(
        roomId,
        user.id
      )
      .run();

    const remainingMembers =
      await getRoomMembers(
        env,
        roomId
      );

    const remainingCount =
      remainingMembers.length;

    /*
     * =================================================
     * NO MEMBERS LEFT
     * =================================================
     */
    if (
      remainingCount === 0
    ) {
      /*
       * Prüfen, ob Whisper-Nachrichten in Reports
       * referenziert werden.
       */
      const reports =
        await env.DB.prepare(`
          SELECT
            COUNT(*) AS total

          FROM chat_reports

          WHERE whisper_message_id
            IN (
              SELECT id

              FROM whisper_messages

              WHERE room_id = ?
            )
        `)
          .bind(
            roomId
          )
          .first();

      const reportCount =
        Number(
          reports?.total || 0
        );

      /*
       * Bei bestehenden Reports behalten wir den
       * Raum technisch als Archiv.
       */
      if (
        reportCount > 0
      ) {
        return json({
          ok:
            true,

          left:
            true,

          room_id:
            roomId,

          room_deleted:
            false,

          archived:
            true,

          remaining_members:
            0
        });
      }

      /*
       * Keine Reports:
       * komplett aufräumen.
       */

      await env.DB.prepare(`
        DELETE FROM whisper_read_state

        WHERE room_id = ?
      `)
        .bind(
          roomId
        )
        .run();

      await env.DB.prepare(`
        DELETE FROM whisper_system_messages

        WHERE room_id = ?
      `)
        .bind(
          roomId
        )
        .run();

      await env.DB.prepare(`
        DELETE FROM whisper_invites

        WHERE room_id = ?
      `)
        .bind(
          roomId
        )
        .run();

      /*
       * Self-Reference lösen.
       */
      await env.DB.prepare(`
        UPDATE whisper_messages

        SET reply_to = NULL

        WHERE room_id = ?
      `)
        .bind(
          roomId
        )
        .run();

      await env.DB.prepare(`
        DELETE FROM whisper_messages

        WHERE room_id = ?
      `)
        .bind(
          roomId
        )
        .run();

      await env.DB.prepare(`
        DELETE FROM whisper_rooms

        WHERE id = ?
      `)
        .bind(
          roomId
        )
        .run();

      return json({
        ok:
          true,

        left:
          true,

        room_id:
          roomId,

        room_deleted:
          true,

        remaining_members:
          0
      });
    }

    /*
     * =================================================
     * HOST TRANSFER
     * =================================================
     *
     * Verlässt der bisherige Host den Raum,
     * bekommt das älteste verbleibende Mitglied
     * automatisch den Host-Status.
     */
    let newHost =
      null;

    if (
      Number(
        room.created_by
      ) ===
      Number(
        user.id
      )
    ) {
      const nextHost =
        remainingMembers[0];

      if (nextHost) {
        await env.DB.prepare(`
          UPDATE whisper_rooms

          SET created_by = ?

          WHERE id = ?
        `)
          .bind(
            nextHost.id,
            roomId
          )
          .run();

        newHost = {
          id:
            nextHost.id,

          username:
            nextHost.username,

          server:
            nextHost.server,

          server_code:
            getServerCode(
              nextHost
            )
        };
      }
    }

    return json({
      ok:
        true,

      left:
        true,

      room_id:
        roomId,

      room_deleted:
        false,

      remaining_members:
        remainingCount,

      new_host:
        newHost
    });

  } catch (error) {
    console.error(
      "DELETE /api/chat/whispers error:",
      error
    );

    return json({
      ok:
        false,

      error:
        "Der Whisper-Chat konnte nicht verlassen werden."
    }, 500);
  }
}
