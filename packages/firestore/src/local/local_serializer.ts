/**
 * @license
 * Copyright 2017 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Timestamp } from '../api/timestamp';
import { Query } from '../core/query';
import { SnapshotVersion } from '../core/snapshot_version';
import {
  Document,
  MaybeDocument,
  NoDocument,
  UnknownDocument
} from '../model/document';
import { DocumentKey } from '../model/document_key';
import { MutationBatch } from '../model/mutation_batch';
import * as api from '../protos/firestore_proto_api';
import { JsonProtoSerializer } from '../remote/serializer';
import { assert, fail } from '../util/assert';

import { documentKeySet, DocumentKeySet } from '../model/collections';
import { decode, encode, EncodedResourcePath } from './encoded_resource_path';
import {
  DbMutationBatch,
  DbNoDocument,
  DbQuery,
  DbRemoteDocument,
  DbTarget,
  DbTimestamp,
  DbTimestampKey,
  DbUnknownDocument
} from './indexeddb_schema';
import { QueryData, QueryPurpose } from './query_data';

/** Serializer for values stored in the LocalStore. */
export class LocalSerializer {
  constructor(private remoteSerializer: JsonProtoSerializer) {}

  /** Decodes a remote document from storage locally to a Document. */
  fromDbRemoteDocument(remoteDoc: DbRemoteDocument): MaybeDocument {
    if (remoteDoc.document) {
      return this.remoteSerializer.fromDocument(
        remoteDoc.document,
        !!remoteDoc.hasCommittedMutations
      );
    } else if (remoteDoc.noDocument) {
      const key = DocumentKey.fromSegments(remoteDoc.noDocument.path);
      const version = this.fromDbTimestamp(remoteDoc.noDocument.readTime);
      return new NoDocument(key, version, {
        hasCommittedMutations: !!remoteDoc.hasCommittedMutations
      });
    } else if (remoteDoc.unknownDocument) {
      const key = DocumentKey.fromSegments(remoteDoc.unknownDocument.path);
      const version = this.fromDbTimestamp(remoteDoc.unknownDocument.version);
      return new UnknownDocument(key, version);
    } else {
      return fail('Unexpected DbRemoteDocument');
    }
  }

  /** Encodes a document for storage locally. */
  toDbRemoteDocument(
    maybeDoc: MaybeDocument,
    readTime: SnapshotVersion
  ): DbRemoteDocument {
    const dbReadTime = this.toDbTimestampKey(readTime);
    const parentPath = maybeDoc.key.path.popLast().toArray();
    if (maybeDoc instanceof Document) {
      const doc = maybeDoc.proto
        ? maybeDoc.proto
        : this.remoteSerializer.toDocument(maybeDoc);
      const hasCommittedMutations = maybeDoc.hasCommittedMutations;
      return new DbRemoteDocument(
        /* unknownDocument= */ null,
        /* noDocument= */ null,
        doc,
        hasCommittedMutations,
        dbReadTime,
        parentPath
      );
    } else if (maybeDoc instanceof NoDocument) {
      const path = maybeDoc.key.path.toArray();
      const readTime = this.toDbTimestamp(maybeDoc.version);
      const hasCommittedMutations = maybeDoc.hasCommittedMutations;
      return new DbRemoteDocument(
        /* unknownDocument= */ null,
        new DbNoDocument(path, readTime),
        /* document= */ null,
        hasCommittedMutations,
        dbReadTime,
        parentPath
      );
    } else if (maybeDoc instanceof UnknownDocument) {
      const path = maybeDoc.key.path.toArray();
      const readTime = this.toDbTimestamp(maybeDoc.version);
      return new DbRemoteDocument(
        new DbUnknownDocument(path, readTime),
        /* noDocument= */ null,
        /* document= */ null,
        /* hasCommittedMutations= */ true,
        dbReadTime,
        parentPath
      );
    } else {
      return fail('Unexpected MaybeDocument');
    }
  }

  toDbTimestampKey(snapshotVersion: SnapshotVersion): DbTimestampKey {
    const timestamp = snapshotVersion.toTimestamp();
    return [timestamp.seconds, timestamp.nanoseconds];
  }

  fromDbTimestampKey(dbTimestampKey: DbTimestampKey): SnapshotVersion {
    const timestamp = new Timestamp(dbTimestampKey[0], dbTimestampKey[1]);
    return SnapshotVersion.fromTimestamp(timestamp);
  }

  private toDbTimestamp(snapshotVersion: SnapshotVersion): DbTimestamp {
    const timestamp = snapshotVersion.toTimestamp();
    return new DbTimestamp(timestamp.seconds, timestamp.nanoseconds);
  }

  private fromDbTimestamp(dbTimestamp: DbTimestamp): SnapshotVersion {
    const timestamp = new Timestamp(
      dbTimestamp.seconds,
      dbTimestamp.nanoseconds
    );
    return SnapshotVersion.fromTimestamp(timestamp);
  }

  /** Encodes a batch of mutations into a DbMutationBatch for local storage. */
  toDbMutationBatch(userId: string, batch: MutationBatch): DbMutationBatch {
    const serializedBaseMutations = batch.baseMutations.map(m =>
      this.remoteSerializer.toMutation(m)
    );
    const serializedMutations = batch.mutations.map(m =>
      this.remoteSerializer.toMutation(m)
    );
    return new DbMutationBatch(
      userId,
      batch.batchId,
      batch.localWriteTime.toMillis(),
      serializedBaseMutations,
      serializedMutations
    );
  }

  /** Decodes a DbMutationBatch into a MutationBatch */
  fromDbMutationBatch(dbBatch: DbMutationBatch): MutationBatch {
    const baseMutations = (dbBatch.baseMutations || []).map(m =>
      this.remoteSerializer.fromMutation(m)
    );
    const mutations = dbBatch.mutations.map(m =>
      this.remoteSerializer.fromMutation(m)
    );
    const timestamp = Timestamp.fromMillis(dbBatch.localWriteTimeMs);
    return new MutationBatch(
      dbBatch.batchId,
      timestamp,
      baseMutations,
      mutations
    );
  }

  /*
   * Encodes a set of document keys into an array of EncodedResourcePaths.
   */
  toDbResourcePaths(keys: DocumentKeySet): EncodedResourcePath[] {
    const encodedKeys: EncodedResourcePath[] = [];

    keys.forEach(key => {
      encodedKeys.push(encode(key.path));
    });

    return encodedKeys;
  }

  /** Decodes an array of EncodedResourcePaths into a set of document keys. */
  fromDbResourcePaths(encodedPaths: EncodedResourcePath[]): DocumentKeySet {
    let keys = documentKeySet();

    for (const documentKey of encodedPaths) {
      keys = keys.add(new DocumentKey(decode(documentKey)));
    }

    return keys;
  }

  /** Decodes a DbTarget into QueryData */
  fromDbTarget(dbTarget: DbTarget): QueryData {
    const version = this.fromDbTimestamp(dbTarget.readTime);
    const lastLimboFreeSnapshotVersion =
      dbTarget.lastLimboFreeSnapshotVersion !== undefined
        ? this.fromDbTimestamp(dbTarget.lastLimboFreeSnapshotVersion)
        : SnapshotVersion.MIN;
    // TODO(b/140573486): Convert to platform representation
    const resumeToken = dbTarget.resumeToken;

    let query: Query;
    if (isDocumentQuery(dbTarget.query)) {
      query = this.remoteSerializer.fromDocumentsTarget(dbTarget.query);
    } else {
      query = this.remoteSerializer.fromQueryTarget(dbTarget.query);
    }
    return new QueryData(
      query,
      dbTarget.targetId,
      QueryPurpose.Listen,
      dbTarget.lastListenSequenceNumber,
      version,
      lastLimboFreeSnapshotVersion,
      resumeToken
    );
  }

  /** Encodes QueryData into a DbTarget for storage locally. */
  toDbTarget(queryData: QueryData): DbTarget {
    assert(
      QueryPurpose.Listen === queryData.purpose,
      'Only queries with purpose ' +
        QueryPurpose.Listen +
        ' may be stored, got ' +
        queryData.purpose
    );
    const dbTimestamp = this.toDbTimestamp(queryData.snapshotVersion);
    const dbLastLimboFreeTimestamp = this.toDbTimestamp(
      queryData.lastLimboFreeSnapshotVersion
    );
    let queryProto: DbQuery;
    if (queryData.query.isDocumentQuery()) {
      queryProto = this.remoteSerializer.toDocumentsTarget(queryData.query);
    } else {
      queryProto = this.remoteSerializer.toQueryTarget(queryData.query);
    }

    let resumeToken: string;

    if (queryData.resumeToken instanceof Uint8Array) {
      // TODO(b/78771403): Convert tokens to strings during deserialization
      assert(
        process.env.USE_MOCK_PERSISTENCE === 'YES',
        'Persisting non-string stream tokens is only supported with mock persistence .'
      );
      resumeToken = queryData.resumeToken.toString();
    } else {
      resumeToken = queryData.resumeToken;
    }

    // lastListenSequenceNumber is always 0 until we do real GC.
    return new DbTarget(
      queryData.targetId,
      queryData.query.canonicalId(),
      dbTimestamp,
      resumeToken,
      queryData.sequenceNumber,
      dbLastLimboFreeTimestamp,
      queryProto
    );
  }
}

/**
 * A helper function for figuring out what kind of query has been stored.
 */
function isDocumentQuery(dbQuery: DbQuery): dbQuery is api.DocumentsTarget {
  return (dbQuery as api.DocumentsTarget).documents !== undefined;
}
