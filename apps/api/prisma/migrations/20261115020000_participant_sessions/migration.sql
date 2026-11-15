-- AlterTable
ALTER TABLE "InvitationToken" ADD COLUMN     "acceptedAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "ParticipantSession" (
    "tokenHash" VARCHAR(64) NOT NULL,
    "invitationId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ParticipantSession_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateIndex
CREATE UNIQUE INDEX "ParticipantSession_invitationId_key" ON "ParticipantSession"("invitationId");

-- CreateIndex
CREATE INDEX "ParticipantSession_expiresAt_idx" ON "ParticipantSession"("expiresAt");

-- AddForeignKey
ALTER TABLE "ParticipantSession" ADD CONSTRAINT "ParticipantSession_invitationId_fkey" FOREIGN KEY ("invitationId") REFERENCES "InvitationToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;
