import { notifyPlayerTopic } from "../resources";
import { Player } from "../types";
import { frontendUrl, stackToken } from "../env";

import { WebClient } from '@slack/web-api';

notifyPlayerTopic.subscribe(async (ctx) => {
    const { player, game } = ctx.req.json() as { game: string, player: Player };

    const wc = new WebClient(stackToken);

    const user = await wc.users.lookupByEmail({
        email: player.email,
    });

    await wc.chat.postMessage({
        channel: user.user.id,
        text: `Hi ${user.user.name}
          It's your turn to move
          ${frontendUrl}/chess/${game}
        `
    });
});