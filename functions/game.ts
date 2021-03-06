import { api, collection, schedule, faas, jwt } from "@nitric/sdk";
import { Chess, Square } from "chess.js";
import short from "short-uuid";
import { notifyPlayerTopic } from "../resources";
import { Player } from "../types";
import { HttpContext, HttpMiddleware } from "@nitric/sdk/lib/faas";

interface GameState {
  fen: string;
  fin?: boolean;
  lastUpdate?: number;
  whitePlayer: Player;
  blackPlayer: Player;
  token?: string;
}

const notifyPlayer = notifyPlayerTopic.for("publishing");
const gamesCollection = collection<GameState>("games").for(
  "reading",
  "writing",
  "deleting"
);

const issuer = process.env.JWT_ISSUER || "https://dev-fn1x0c3o.us.auth0.com/";
const audience = process.env.JWT_AUDIENCE || "testing";

const chessApi = api("chess", {
  securityDefinitions: {
    user: jwt({
      issuer,
      audiences: [audience],
    })
  },
  security: { user: [] }
});

type HttpGameContext = HttpContext & { game: GameState };

export const getGame: HttpMiddleware = async (ctx, next) => {
  const { name } = ctx.req.params;

  if (!name) {
    ctx.res.body = "missing path parameter for name";
    ctx.res.status = 400;
    return ctx;
  }

  try {
    const game = await gamesCollection.doc(name).get();
    // attach gamestate to the HTTP context
    ctx["game"] = game;
  } catch (e) {
    ctx.res.body = `Could not find game ${name}`;
    ctx.res.status = 404;
    return ctx;
  }

  return next && next(ctx);
};

// create a new game
chessApi.post("/game", async (ctx) => {
  const chess = new Chess();
  const gameId = short.generate();

  const { w, b } = ctx.req.json() as { w: Player; b: Player };

  const now = new Date().getTime();
  const nextTurnToken = short.generate();

  await gamesCollection.doc(gameId).set({
    fen: chess.fen(),
    fin: false,
    lastUpdate: now,
    whitePlayer: w,
    blackPlayer: b,
    token: nextTurnToken,
  });

  // notify the first player it's there turn
  await notifyPlayer.publish({
    payload: { player: w, game: gameId, token: nextTurnToken },
  });

  ctx.res.body = `Game ${gameId} Created;
  ${chess.ascii()}
      `;

  return ctx;
});

// get game detail
chessApi.get("/game/:name", faas.createHandler(getGame, async (ctx) => {
  const { game } = ctx as HttpGameContext;
  const { fen } = game;
  const chess = new Chess(fen);

  ctx.res.headers["Content-Type"] = ["application/json"];
  ctx.res.body = JSON.stringify({
    moves: chess.moves({ verbose: true }),
    fen: chess.fen(),
  });

  return ctx;
}));

// make a move
chessApi.post("/game/:name", faas.createHandler(getGame, async (ctx) => {
  const { game: state } = ctx as HttpGameContext;
  const { name } = ctx.req.params;
  const { token } = ctx.req.query as any as Record<string, string>;
  const { from, to } = ctx.req.json() as Record<string, Square>;

  const { fen, whitePlayer, blackPlayer, token: ntToken } = state;

  const game = new Chess(fen);

  // test if the correct token was provided
  if (!token || token !== ntToken) {
    ctx.res.status = 403;
    ctx.res.body = `Not authorized!`;
    return ctx;
  }

  const move = game.move({ from, to });
  if (!move) {
    ctx.res.status = 403;
    ctx.res.body = `Illegal move!!! cannot move ${from} to ${to}`;
    return ctx;
  }

  const finished = game.in_checkmate() || game.in_draw() || game.in_stalemate();

  // generate a new next turn token
  const nextTurnToken = short.generate();

  await gamesCollection.doc(name).set({
    fen: game.fen(),
    fin: finished,
    lastUpdate: new Date().getTime(),
    whitePlayer,
    blackPlayer,
    token: nextTurnToken,
  });

  ctx.res.body = "move submitted";

  if (finished) {
    ctx.res.body = "game over\n" + ctx.res.body;

    // notify all player the game is over
    await Promise.all(
      [blackPlayer, whitePlayer].map(async (p) => {
        return await notifyPlayer.publish({
          payload: {
            player: p,
            game: name,
            token: nextTurnToken,
            finished: true,
          },
        });
      })
    );
  } else {
    const currentPlayer = game.turn() == "b" ? blackPlayer : whitePlayer;
    // notify the next player it's there turn
    await notifyPlayer.publish({
      payload: {
        player: currentPlayer,
        game: name,
        token: nextTurnToken,
      },
    });
  }

  return ctx;
}));

// cleanup games once per day
schedule("finished-cleanup").every("day", async (ctx) => {
  const gameStream = gamesCollection
    .query()
    .where("fin", "==", "true")
    .stream();

  gameStream.on("data", (game) => {
    game.ref.delete();
  });

  await new Promise<void>((res) => {
    gameStream.on("end", () => {
      res();
    });
  });
});

// A week in milliseconds
const GAME_STALE_DAYS = 3;
const staleGameTimeMs = GAME_STALE_DAYS * 24 * 60 * 60 * 1000;

// cleanup idle games once per week
schedule("idle-cleanup").every("7 days", async (ctx) => {
  const staleTime = new Date().getTime() - staleGameTimeMs;
  const gameStream = gamesCollection
    .query()
    .where("lastUpdate", "<=", staleTime)
    .stream();

  gameStream.on("data", async (game) => {
    await game.ref.delete();
  });

  await new Promise<void>((res) => {
    gameStream.on("end", () => {
      res();
    });
  });
});
