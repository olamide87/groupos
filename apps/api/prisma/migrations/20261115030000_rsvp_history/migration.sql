-- AlterTable
ALTER TABLE "Rsvp" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "RsvpHistory" ADD COLUMN     "revision" INTEGER;

-- CreateTable
CREATE TABLE "RsvpSubmission" (
    "participantId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "response" "RsvpResponse" NOT NULL,
    "expectedVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RsvpSubmission_pkey" PRIMARY KEY ("participantId","requestId")
);

-- CreateIndex
CREATE UNIQUE INDEX "RsvpHistory_participantId_revision_key" ON "RsvpHistory"("participantId", "revision");

-- AddForeignKey
ALTER TABLE "RsvpSubmission" ADD CONSTRAINT "RsvpSubmission_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
