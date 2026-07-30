/**
 * memory.impl.ts — MemoryService gRPC handler implementations.
 *
 * Delegates all calls to the MemoryService class (SQLite-backed).
 * All handlers are wrapped in try/catch — errors go to stderr and return
 * safe defaults so that memory failures never crash the agent runtime.
 */
import type * as grpc from "@grpc/grpc-js";
import type { MemoryService } from "../memory.service.js";
import type {
  GrpcStoreSessionRequest,
  GrpcStoreSessionResponse,
  GrpcAppendMessageRequest,
  GrpcAppendMessageResponse,
  GrpcFinalizeSessionRequest,
  GrpcFinalizeSessionResponse,
  GrpcGetRecentMessagesRequest,
  GrpcGetRecentMessagesResponse,
  GrpcSearchMessagesRequest,
  GrpcStoredMessage,
  GrpcDeleteUserDataRequest,
  GrpcDeleteUserDataResponse,
  GrpcDumpStateRequest,
  GrpcDumpStateResponse,
  GrpcRestoreStateRequest,
  GrpcRestoreStateResponse,
  GrpcStoreLessonsRequest,
  GrpcStoreLessonsResponse,
  GrpcGetRelevantLessonsRequest,
  GrpcGetRelevantLessonsResponse,
  GrpcListLessonsRequest,
  GrpcListLessonsResponse,
  GrpcStoredLesson,
  GrpcStoreHarnessPatchRequest,
  GrpcStoreHarnessPatchResponse,
  GrpcGetActivePatchesRequest,
  GrpcGetActivePatchesResponse,
  GrpcHarnessPatchEntry,
} from "@tessera/shared";
import type { LessonCategory } from "../memory.service.js";

type UnaryCall<Req, Res> = grpc.ServerUnaryCall<Req, Res>;
type StreamCall<Req, Res> = grpc.ServerWritableStream<Req, Res>;
type Callback<Res> = grpc.sendUnaryData<Res>;

export function makeMemoryImpl(memorySvc: MemoryService) {
  return {
    StoreSession(
      call: UnaryCall<GrpcStoreSessionRequest, GrpcStoreSessionResponse>,
      callback: Callback<GrpcStoreSessionResponse>
    ): void {
      try {
        const req = call.request;
        memorySvc.storeSession({
          session_id: req.session_id,
          user_id: req.user_id,
          provider: req.provider ?? "",
          created_at: req.created_at || Date.now(),
        });
        callback(null, { success: true });
      } catch (err) {
        process.stderr.write(`[memory-grpc] storeSession error: ${String(err)}\n`);
        callback(null, { success: false });
      }
    },

    AppendMessage(
      call: UnaryCall<GrpcAppendMessageRequest, GrpcAppendMessageResponse>,
      callback: Callback<GrpcAppendMessageResponse>
    ): void {
      try {
        const req = call.request;
        const messageId = memorySvc.appendMessage({
          session_id: req.session_id,
          user_id: req.user_id,
          role: req.role,
          content: req.content ?? "",
          tool_calls_json: req.tool_calls_json ?? "",
          tool_call_id: req.tool_call_id ?? "",
          tool_name: req.tool_name ?? "",
          created_at: req.created_at || Date.now(),
        });
        callback(null, { message_id: messageId, success: true });
      } catch (err) {
        process.stderr.write(`[memory-grpc] appendMessage error: ${String(err)}\n`);
        callback(null, { message_id: 0, success: false });
      }
    },

    FinalizeSession(
      call: UnaryCall<GrpcFinalizeSessionRequest, GrpcFinalizeSessionResponse>,
      callback: Callback<GrpcFinalizeSessionResponse>
    ): void {
      try {
        const req = call.request;
        memorySvc.finalizeSession({
          session_id: req.session_id,
          ended_at: req.ended_at || Date.now(),
          input_tokens: req.input_tokens ?? 0,
          output_tokens: req.output_tokens ?? 0,
          cost_usd: req.cost_usd ?? 0,
          tool_call_count: req.tool_call_count ?? 0,
        });
        callback(null, { success: true });
      } catch (err) {
        process.stderr.write(`[memory-grpc] finalizeSession error: ${String(err)}\n`);
        callback(null, { success: false });
      }
    },

    GetRecentMessages(
      call: UnaryCall<GrpcGetRecentMessagesRequest, GrpcGetRecentMessagesResponse>,
      callback: Callback<GrpcGetRecentMessagesResponse>
    ): void {
      try {
        const { user_id, limit } = call.request;
        const messages = memorySvc.getRecentMessages(user_id, limit || 30);
        const grpcMessages: GrpcStoredMessage[] = messages.map((m) => ({
          id: m.id,
          session_id: m.session_id,
          user_id: m.user_id,
          role: m.role,
          content: m.content,
          tool_calls_json: m.tool_calls_json,
          tool_call_id: m.tool_call_id,
          tool_name: m.tool_name,
          created_at: m.created_at,
        }));
        callback(null, { messages: grpcMessages });
      } catch (err) {
        process.stderr.write(`[memory-grpc] getRecentMessages error: ${String(err)}\n`);
        callback(null, { messages: [] });
      }
    },

    SearchMessages(
      call: StreamCall<GrpcSearchMessagesRequest, GrpcStoredMessage>
    ): void {
      const { user_id, query, limit } = call.request;
      memorySvc.searchMessages(user_id, query, limit || 20)
        .then((messages) => {
          for (const m of messages) {
            call.write({
              id: m.id,
              session_id: m.session_id,
              user_id: m.user_id,
              role: m.role,
              content: m.content,
              tool_calls_json: m.tool_calls_json,
              tool_call_id: m.tool_call_id,
              tool_name: m.tool_name,
              created_at: m.created_at,
            });
          }
          call.end();
        })
        .catch((err: unknown) => {
          process.stderr.write(`[memory-grpc] searchMessages error: ${String(err)}\n`);
          call.destroy(err instanceof Error ? err : new Error(String(err)));
        });
    },

    DeleteUserData(
      call: UnaryCall<GrpcDeleteUserDataRequest, GrpcDeleteUserDataResponse>,
      callback: Callback<GrpcDeleteUserDataResponse>
    ): void {
      try {
        const deletedCount = memorySvc.deleteUserData(call.request.user_id);
        callback(null, { deleted_count: deletedCount, success: true });
      } catch (err) {
        process.stderr.write(`[memory-grpc] deleteUserData error: ${String(err)}\n`);
        callback(null, { deleted_count: 0, success: false });
      }
    },

    DumpState(
      _call: UnaryCall<GrpcDumpStateRequest, GrpcDumpStateResponse>,
      callback: Callback<GrpcDumpStateResponse>
    ): void {
      try {
        const { data, checksum } = memorySvc.dumpState();
        callback(null, {
          data,
          checksum_sha256: checksum,
          success: true,
          error_message: "",
        });
      } catch (err) {
        callback(null, {
          data: Buffer.alloc(0),
          checksum_sha256: "",
          success: false,
          error_message: err instanceof Error ? err.message : String(err),
        });
      }
    },

    RestoreState(
      call: UnaryCall<GrpcRestoreStateRequest, GrpcRestoreStateResponse>,
      callback: Callback<GrpcRestoreStateResponse>
    ): void {
      try {
        memorySvc.restoreState(Buffer.from(call.request.data), call.request.checksum_sha256);
        callback(null, {
          success: true,
          error_message: "",
          restart_required: true,
        });
      } catch (err) {
        callback(null, {
          success: false,
          error_message: err instanceof Error ? err.message : String(err),
          restart_required: false,
        });
      }
    },

    StoreLessons(
      call: UnaryCall<GrpcStoreLessonsRequest, GrpcStoreLessonsResponse>,
      callback: Callback<GrpcStoreLessonsResponse>
    ): void {
      try {
        const { source_session_id, user_id, lessons } = call.request;
        const validCategories = new Set(["mistake", "preference", "procedure", "fact"]);
        const validLessons = (lessons ?? [])
          .filter((l) => l.lesson_text?.trim().length > 0 && validCategories.has(l.category))
          .map((l) => ({
            lesson_text: l.lesson_text.trim().slice(0, 150),
            category: l.category as LessonCategory,
          }));
        const stored_count = memorySvc.storeLessons({
          source_session_id,
          user_id,
          lessons: validLessons,
        });
        callback(null, { stored_count, success: true });
      } catch (err) {
        process.stderr.write(`[memory-grpc] storeLessons error: ${String(err)}\n`);
        callback(null, { stored_count: 0, success: false });
      }
    },

    GetRelevantLessons(
      call: UnaryCall<GrpcGetRelevantLessonsRequest, GrpcGetRelevantLessonsResponse>,
      callback: Callback<GrpcGetRelevantLessonsResponse>
    ): void {
      const { user_id, query, limit } = call.request;
      memorySvc.getRelevantLessons(user_id, query ?? "", limit || 5)
        .then((rows) => {
          const lessons: GrpcStoredLesson[] = rows.map((r) => ({
            id: r.id,
            user_id: r.user_id,
            source_session_id: r.source_session_id,
            lesson_text: r.lesson_text,
            category: r.category,
            created_at: r.created_at,
            access_count: r.access_count,
          }));
          callback(null, { lessons });
        })
        .catch((err: unknown) => {
          process.stderr.write(`[memory-grpc] getRelevantLessons error: ${String(err)}\n`);
          callback(null, { lessons: [] });
        });
    },

    ListLessons(
      call: UnaryCall<GrpcListLessonsRequest, GrpcListLessonsResponse>,
      callback: Callback<GrpcListLessonsResponse>
    ): void {
      try {
        const { user_id, limit } = call.request;
        const rows = memorySvc.listLessons(user_id, limit || 20);
        const lessons: GrpcStoredLesson[] = rows.map((r) => ({
          id: r.id,
          user_id: r.user_id,
          source_session_id: r.source_session_id,
          lesson_text: r.lesson_text,
          category: r.category,
          created_at: r.created_at,
          access_count: r.access_count,
        }));
        callback(null, { lessons });
      } catch (err) {
        process.stderr.write(`[memory-grpc] listLessons error: ${String(err)}\n`);
        callback(null, { lessons: [] });
      }
    },

    StoreHarnessPatch(
      call: UnaryCall<GrpcStoreHarnessPatchRequest, GrpcStoreHarnessPatchResponse>,
      callback: Callback<GrpcStoreHarnessPatchResponse>
    ): void {
      try {
        const req = call.request;
        memorySvc.storeHarnessPatch({
          id: req.id,
          patch_type: req.patch_type,
          target: req.target,
          proposed_change: req.proposed_change,
          confidence: req.confidence,
          recommendation: req.recommendation,
          source_patterns: req.source_patterns,
          applied: req.applied ? 1 : 0,
          applied_at: req.applied_at || null,
          generated_at: req.generated_at,
        });
        callback(null, { success: true });
      } catch (err) {
        process.stderr.write(`[memory-grpc] storeHarnessPatch error: ${String(err)}\n`);
        callback(null, { success: false });
      }
    },

    GetActivePatches(
      call: UnaryCall<GrpcGetActivePatchesRequest, GrpcGetActivePatchesResponse>,
      callback: Callback<GrpcGetActivePatchesResponse>
    ): void {
      try {
        const { limit } = call.request;
        const rows = memorySvc.getActivePatches(limit || 50);
        const patches: GrpcHarnessPatchEntry[] = rows.map((r) => ({
          id: r.id,
          patch_type: r.patch_type,
          target: r.target,
          proposed_change: r.proposed_change,
          confidence: r.confidence,
          recommendation: r.recommendation,
          source_patterns: r.source_patterns,
          applied: r.applied !== 0,
          applied_at: r.applied_at ?? 0,
          generated_at: r.generated_at,
        }));
        callback(null, { patches });
      } catch (err) {
        process.stderr.write(`[memory-grpc] getActivePatches error: ${String(err)}\n`);
        callback(null, { patches: [] });
      }
    },
  };
}
