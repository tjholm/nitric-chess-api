import { notifyPlayerTopic } from "../resources";
import { frontendUrl, stackToken } from "../env";

import { WebClient } from '@slack/web-api';
import { Notification } from "../types/notification";

notifyPlayerTopic.subscribe(async (ctx) => {
    const { player, game, token, finished } = ctx.req.json() as Notification;

    const wc = new WebClient(stackToken);
    const user = await wc.users.lookupByEmail({
        email: player.email,
    });

    if (!finished) {
        await wc.chat.postMessage({
            channel: user.user.id,
            text: `Hi ${user.user.name}
              It's your turn to move
              ${frontendUrl}/chess/${game}?token=${token}
            `
        });
    } else {
        await wc.chat.postMessage({
            channel: user.user.id,
            text: `Hi ${user.user.name}
              It's game over see the finished game at:
              ${frontendUrl}/chess/${game}
            `
        });
    }
});