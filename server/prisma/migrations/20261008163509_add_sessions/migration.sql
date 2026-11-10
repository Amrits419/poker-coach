-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "site" TEXT,
    "heroName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "stakes" TEXT,
    "handsTotal" INTEGER NOT NULL DEFAULT 0,
    "handsGraded" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecordedHand" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "externalId" TEXT,
    "hhText" TEXT NOT NULL,
    "heroPosition" TEXT,
    "heroCards" TEXT,
    "board" TEXT[],
    "playersDealt" INTEGER NOT NULL,
    "heroVoluntary" BOOLEAN NOT NULL DEFAULT false,
    "heroPfr" BOOLEAN NOT NULL DEFAULT false,
    "sawFlop" BOOLEAN NOT NULL DEFAULT false,
    "netBb" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "gradeMode" TEXT NOT NULL,
    "gradeNote" TEXT,
    "startState" JSONB,
    "analysis" JSONB,
    "details" JSONB,
    "score" INTEGER,
    "mistakes" INTEGER NOT NULL DEFAULT 0,
    "leaks" TEXT[],
    "gradedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecordedHand_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecordedHand_sessionId_gradedAt_idx" ON "RecordedHand"("sessionId", "gradedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RecordedHand_sessionId_seq_key" ON "RecordedHand"("sessionId", "seq");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordedHand" ADD CONSTRAINT "RecordedHand_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
