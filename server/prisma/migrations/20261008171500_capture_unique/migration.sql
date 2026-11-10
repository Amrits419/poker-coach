-- One session per PokerRecorder recording (NULL captureDir values do not collide)
CREATE UNIQUE INDEX "Session_userId_captureDir_key" ON "Session"("userId", "captureDir");
