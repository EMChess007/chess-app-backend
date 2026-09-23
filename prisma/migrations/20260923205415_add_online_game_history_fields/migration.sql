-- AlterEnum
ALTER TYPE "OpponentType" ADD VALUE 'online';

-- AlterTable
ALTER TABLE "games" ADD COLUMN     "opponent_username" TEXT,
ADD COLUMN     "player_color" TEXT;
