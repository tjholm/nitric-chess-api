import { Player } from "./player";

export interface Notification {
    token?: string,
    game: string,
    player: Player;
    finished?: boolean;
}