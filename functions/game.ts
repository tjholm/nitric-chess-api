import { api, collection, schedule } from "@nitric/sdk";
import { Chess, Square } from "chess.js";
import short from "short-uuid";
import { CollectionRef } from "@nitric/sdk/lib/api/documents/v0/collection-ref";

interface GameState {
    fen: string;
    fin?: boolean;
    lastUpdate?: number;
}

const gamesCollection: CollectionRef<GameState> = collection('games').for('reading', 'writing', 'deleting');

const chessApi = api('chess');

// print a game
chessApi.get("/game/:name", async (ctx) => {
    const { name } = ctx.req.params;
    try {
        const { fen } = await gamesCollection.doc(name).get();
        const chess = new Chess(fen);
    
        ctx.res.body = chess.ascii();
    } catch (e) {
        ctx.res.body = `Could not find game ${name}`;
        ctx.res.status = 404;

    }
    return ctx;
});

// print legal moves
chessApi.get("/game/:name/moves", async (ctx) => {
    const { name } = ctx.req.params;
    try {
        const { fen } = await gamesCollection.doc(name).get();

        const chess = new Chess(fen);

        ctx.res.body = JSON.stringify(chess.moves({ verbose: true }));
        ctx.res.headers['Content-Type'] = ["application/json"];

        return ctx;
    } catch (e) {
        ctx.res.body = `Cannot find game ${name}`;
        ctx.res.status = 404;
    }
});

chessApi.get("/game", async (ctx) => {
    const gameStream = gamesCollection.query().stream();

    const games: any[] = [];

    gameStream.on('data', (game) => {
        games.push({ id: game.ref.id, ...game.content});
    });

    await new Promise<void>((res) => {
        gameStream.on('end', () => {
            res();
        });
    });

    ctx.res.body = JSON.stringify(games);
    ctx.res.headers['Content-Type'] = ['application/json']; 

    return ctx;
});

// create a new game
chessApi.post("/game", async (ctx) => {
    const chess = new Chess();
    const gameId = short.generate();

    const now = new Date().getTime();

    await gamesCollection.doc(gameId).set({
        fen: chess.fen(),
        fin: false,
        lastUpdate: now,
    });

    ctx.res.body = `Game ${gameId} Created 
${chess.ascii()}
    `;

    return ctx;
});

chessApi.post("/game/:name", async (ctx) => {
    const { name } = ctx.req.params;
    const { from, to } = ctx.req.json() as Record<string, Square>;

    try {
        const { fen } = await gamesCollection.doc(name).get();
        const game = new Chess(fen);
    
        const move = game.move({ from, to });
    
        if (!move) {
            ctx.res.status = 403;
            ctx.res.body = `Illegal move!!! cannot move ${from} to ${to}`;
            return ctx;
        }
    
        const finished = game.in_checkmate() || game.in_draw() || game.in_stalemate();
    
        await gamesCollection.doc(name).set({ 
            fen: game.fen(),
            fin: finished,
            lastUpdate: new Date().getTime(),
        })
    
        ctx.res.body = game.ascii();
    
        if (finished) {
            ctx.res.body = "game over\n" + ctx.res.body;
        }
    
        return ctx;
    } catch (e) {
        ctx.res.body = `unable to find game ${name}`;
        ctx.res.status = 404;
    }
    
});

// cleanup games once per day
schedule("cleanup-finished-games").every('day', async (ctx) => {
    const gameStream = gamesCollection.query().where('fin', '==', 'true').stream();

    gameStream.on('data', (game) => {
        game.ref.delete()
    });

    await new Promise<void>((res) => {
        gameStream.on('end', () => {
            res();
        });
    });
})

const staleGameTimeMs = 60 * 1000;

// cleanup idle games once per week
schedule("cleanup-idle-games").every('day', async (ctx) => {
    const staleTime = new Date().getTime() - staleGameTimeMs;
    const gameStream = gamesCollection.query().where('lastUpdate', '<=', staleTime).stream();

    gameStream.on('data', async (game) => {
        await game.ref.delete();
    });

    await new Promise<void>((res) => {
        gameStream.on('end', () => {
            res();
        });
    });
})