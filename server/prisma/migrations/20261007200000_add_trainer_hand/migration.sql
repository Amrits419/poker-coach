-- DropForeignKey
ALTER TABLE "Hand" DROP CONSTRAINT "Hand_userId_fkey";

-- DropTable
DROP TABLE "Hand";

-- CreateTable
CREATE TABLE "TrainerHand" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "setup" JSONB NOT NULL,
    "scenario" JSONB NOT NULL,
    "userActions" JSONB NOT NULL,
    "analysis" JSONB,
    "leaks" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrainerHand_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "TrainerHand" ADD CONSTRAINT "TrainerHand_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
