import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as anchor from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SolanaService } from '../tx/solana.service';
import { IndexerRepository } from './indexer.repository';

const { BorshCoder, EventParser } = anchor;

/** Anchor emits pubkeys as PublicKey and u64/i64 as BN. */
function pubkeyOf(value: unknown): string {
  if (value instanceof PublicKey) return value.toBase58();
  return String(value);
}
function numberOf(value: unknown): number {
  if (typeof value === 'object' && value !== null && 'toNumber' in value) {
    return (value as { toNumber(): number }).toNumber();
  }
  return Number(value);
}

/**
 * Mirrors confirmed program events into audit_events and flips records out
 * of pending_chain when RecordIssued lands. Subscribes with onLogs on the
 * confirmed commitment: the mirrored row is only as trustworthy as the
 * confirmation behind it, and an optimistic log could activate a record
 * whose transaction later rolled back.
 *
 * Every event resolves its local row through keys the chain and the DB
 * share — wallet pubkeys and the record PDA — so a log line that does not
 * match a persisted reservation or anchored record is dropped, never
 * invented. Set INDEXER_ENABLED=false to run the API without the listener
 * (local dev without RPC websockets).
 */
@Injectable()
export class IndexerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IndexerService.name);
  private listenerId?: number;
  private parser?: anchor.EventParser;

  constructor(
    private readonly solana: SolanaService,
    private readonly repository: IndexerRepository,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    if (this.config.get<string>('INDEXER_ENABLED') === 'false') {
      this.logger.warn('Indexer disabled (INDEXER_ENABLED=false)');
      return;
    }
    const idl = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'idl', 'hcd.json'), 'utf8'),
    ) as anchor.Idl;
    this.parser = new EventParser(this.solana.programId, new BorshCoder(idl));
    this.listenerId = this.solana.connection.onLogs(
      this.solana.programId,
      (logs) => void this.handleLogs(logs.logs, logs.signature, logs.err),
      'confirmed',
    );
    this.logger.log(
      `Subscribed to program logs (${this.solana.programId.toBase58()})`,
    );
  }

  async onModuleDestroy() {
    if (this.listenerId !== undefined) {
      await this.solana.connection.removeOnLogsListener(this.listenerId);
    }
  }

  /** Parses one transaction's log lines and mirrors every event it emitted.
   * Never throws into the onLogs callback — a bad log batch is logged and
   * dropped, not allowed to kill the listener. A failed transaction still
   * reaches onLogs with the events it emitted before reverting; its state
   * changes never happened on-chain, so nothing is mirrored. */
  async handleLogs(logLines: string[], signature: string, err?: unknown) {
    if (!this.parser || err) return;
    try {
      for (const event of this.parser.parseLogs(logLines)) {
        await this.handleEvent(
          event.name,
          event.data as Record<string, unknown>,
          signature,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Failed to mirror logs for ${signature}: ${String(error)}`,
      );
    }
  }

  async handleEvent(
    name: string,
    data: Record<string, unknown>,
    signature: string,
  ) {
    switch (name) {
      case 'RecordIssued':
        return this.onRecordIssued(data, signature);
      case 'RecordDisputed':
        return this.onRecordStatus(data, signature, 'disputed');
      case 'RecordVoided':
        return this.onRecordStatus(data, signature, 'voided');
      case 'AccessGranted':
        return this.onAccess(data, signature, 'access_granted', 'patient');
      case 'AccessRevoked':
        return this.onAccess(data, signature, 'access_revoked', 'patient');
      case 'AccessLogged':
        return this.onAccess(data, signature, 'access_logged', 'doctor');
      case 'ConfigUpdated':
        return this.mirror(signature, 'config_updated', null, null, null);
      default:
        this.logger.warn(`Unknown event ${name} in ${signature}`);
    }
  }

  /** RecordIssued binds the reservation to its anchored PDA. The emitted
   * record address is checked against a locally derived PDA before the
   * update — an event whose seeds don't reproduce the address is not ours. */
  private async onRecordIssued(
    data: Record<string, unknown>,
    signature: string,
  ) {
    const recordPda = pubkeyOf(data['record']);
    const patientWallet = pubkeyOf(data['patient']);
    const issuerWallet = pubkeyOf(data['issuer']);
    const recordId = numberOf(data['record_id']);

    const derived = this.solana
      .recordPda(new PublicKey(patientWallet), recordId)
      .toBase58();
    if (derived !== recordPda) {
      this.logger.warn(
        `RecordIssued ignored: derived PDA ${derived} != event record ${recordPda}`,
      );
      return;
    }

    const patientUserId = await this.repository.userIdByWallet(patientWallet);
    const doctor = await this.repository.doctorByWallet(issuerWallet);
    if (!patientUserId || !doctor) {
      this.logger.warn(
        `RecordIssued ignored: unknown patient or issuer wallet (${signature})`,
      );
      return;
    }

    // The event carries no storage_ref; read it from the anchored account so
    // only the exact reservation (records.id) is activated, even when the
    // same doctor has several pending uploads for the same patient.
    const account = (await this.solana.program.account['record']
      .fetch(new PublicKey(recordPda))
      .catch(() => null)) as { storageRef?: string } | null;
    if (!account?.storageRef) {
      this.logger.warn(
        `RecordIssued ignored: record account unreadable (${signature})`,
      );
      return;
    }

    const row = await this.repository.activateRecord({
      storageRef: account.storageRef,
      recordPda,
      recordId,
      patientUserId,
      doctorId: doctor.id,
    });
    if (!row) {
      this.logger.warn(
        `RecordIssued ignored: no pending_chain reservation matched (${signature})`,
      );
      return;
    }
    await this.mirror(signature, 'record_issued', row, row.id, doctor.user_id);
  }

  private async onRecordStatus(
    data: Record<string, unknown>,
    signature: string,
    status: 'disputed' | 'voided',
  ) {
    const row = await this.repository.recordByPda(pubkeyOf(data['record']));
    if (!row) {
      this.logger.warn(
        `Record${status === 'disputed' ? 'Disputed' : 'Voided'} ignored: unknown record PDA (${signature})`,
      );
      return;
    }
    await this.repository.setRecordStatus(row.id, status);
    const actor = await this.repository.userIdByWallet(
      pubkeyOf(status === 'disputed' ? data['patient'] : data['issuer']),
    );
    await this.mirror(signature, `record_${status}`, row, row.id, actor);
  }

  private async onAccess(
    data: Record<string, unknown>,
    signature: string,
    eventType: 'access_granted' | 'access_revoked' | 'access_logged',
    actorField: 'patient' | 'doctor',
  ) {
    const row = await this.repository.recordByPda(pubkeyOf(data['record']));
    if (!row) {
      this.logger.warn(
        `${eventType} ignored: unknown record PDA (${signature})`,
      );
      return;
    }
    const actor = await this.repository.userIdByWallet(
      pubkeyOf(data[actorField]),
    );
    await this.mirror(signature, eventType, row, row.id, actor);
  }

  /** Writes the audit row once per (signature, event, record). */
  private async mirror(
    signature: string,
    eventType: string,
    row: { organization_id: string } | null,
    recordId: string | null,
    actorUserId: string | null,
  ) {
    if (await this.repository.auditExists(signature, eventType, recordId)) {
      return;
    }
    await this.repository.insertAudit({
      organization_id: row?.organization_id ?? null,
      record_id: recordId,
      actor_user_id: actorUserId,
      event_type: eventType,
      tx_signature: signature,
    });
  }
}
