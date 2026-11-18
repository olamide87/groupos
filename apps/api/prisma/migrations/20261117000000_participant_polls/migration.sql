-- AlterEnum
ALTER TYPE "PollStatus" ADD VALUE 'CANCELLED';

-- DropIndex
DROP INDEX "Vote_pollId_participantId_key";

-- AlterTable
ALTER TABLE "Poll" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PollOption" ADD COLUMN     "amountMinor" INTEGER,
ADD COLUMN     "currency" VARCHAR(3),
ADD COLUMN     "endsAt" TIMESTAMPTZ(3),
ADD COLUMN     "startsAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "AuditEntry" ADD COLUMN     "actorParticipantId" UUID;

-- CreateTable
CREATE TABLE "PollBallot" (
    "pollId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "participantId" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PollBallot_pkey" PRIMARY KEY ("pollId","participantId")
);

-- CreateTable
CREATE TABLE "PollSubmission" (
    "pollId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "participantId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "payloadHash" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PollSubmission_pkey" PRIMARY KEY ("pollId","participantId","requestId")
);

-- CreateIndex
CREATE INDEX "PollBallot_participantId_eventId_idx" ON "PollBallot"("participantId", "eventId");

-- CreateIndex
CREATE INDEX "PollSubmission_participantId_eventId_idx" ON "PollSubmission"("participantId", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "Vote_pollId_participantId_optionId_key" ON "Vote"("pollId", "participantId", "optionId");

-- CreateIndex
CREATE INDEX "AuditEntry_actorParticipantId_eventId_idx" ON "AuditEntry"("actorParticipantId", "eventId");

-- AddForeignKey
ALTER TABLE "PollBallot" ADD CONSTRAINT "PollBallot_pollId_eventId_fkey" FOREIGN KEY ("pollId", "eventId") REFERENCES "Poll"("id", "eventId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PollBallot" ADD CONSTRAINT "PollBallot_participantId_eventId_fkey" FOREIGN KEY ("participantId", "eventId") REFERENCES "Participant"("id", "eventId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PollSubmission" ADD CONSTRAINT "PollSubmission_pollId_eventId_fkey" FOREIGN KEY ("pollId", "eventId") REFERENCES "Poll"("id", "eventId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PollSubmission" ADD CONSTRAINT "PollSubmission_participantId_eventId_fkey" FOREIGN KEY ("participantId", "eventId") REFERENCES "Participant"("id", "eventId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEntry" ADD CONSTRAINT "AuditEntry_actorParticipantId_eventId_fkey" FOREIGN KEY ("actorParticipantId", "eventId") REFERENCES "Participant"("id", "eventId") ON DELETE RESTRICT ON UPDATE CASCADE;
