use serde::{Deserialize, Serialize};

use crate::*;

/// Either direction, so one sample list can hold both. Nothing outside the tests needs it:
/// each side only reads one direction and writes the other.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum AnyMessage {
    Request(ServerRequest),
    Response(ServerResponse),
}

impl AnyMessage {
    fn session_id(&self) -> Option<&str> {
        match self {
            Self::Request(request) => request.session_id(),
            Self::Response(response) => response.session_id(),
        }
    }
}

fn id_samples() -> Vec<AnyMessage> {
    let mut samples = vec![
        AnyMessage::Response(ServerResponse::TerminalOutput(TerminalOutput {
            session_id: "session".to_string(),
            terminal_id: "terminal".to_string(),
            bytes: vec![0, 27, 91, 255],
        })),
        AnyMessage::Request(ServerRequest::Shutdown),
        AnyMessage::Response(ServerResponse::SessionCloseOk),
        AnyMessage::Response(ServerResponse::Ping { seq: u64::MAX }),
        AnyMessage::Response(ServerResponse::Error(ErrorResponse {
            message: "no".to_string(),
            session_id: None,
        })),
        AnyMessage::Request(ServerRequest::Spawn(SpawnRequest {
            agent_id: "claude-acp".to_string(),
            session_id: "session".to_string(),
            cwd: "/tmp".to_string(),
            additional_directories: vec!["~/other".to_string()],
            project_path: None,
            meta: SessionMeta::default(),
        })),
        AnyMessage::Response(ServerResponse::SessionUpdate(SessionUpdate {
            session_id: "session".to_string(),
            payload: serde_json::json!({
                "project": 3,
                "nested": {"id": 9, "type": "inner", "list": [1, null, 2.5]},
            }),
        })),
        // Payloads with a top-level `id` and `request_id` of their own, which the frame's key
        // must not collide with.
        AnyMessage::Response(ServerResponse::SaveAutomationOk(Automation {
            id: "automation-1".to_string(),
            project_path: "/srv/shop".to_string(),
            name: "Nightly".to_string(),
            prompt: "Run the checks".to_string(),
            agent_id: "claude-acp".to_string(),
            cron: None,
            timezone: "UTC".to_string(),
            enabled: false,
            model: None,
            permission_mode: None,
            effort: None,
            workspace: AutomationWorkspace::NewWorktree {
                base_branch: "main".to_string(),
            },
            webhook_enabled: false,
            webhook_overlap: WebhookOverlap::default(),
            webhook_secret: None,
            next_due_at: None,
        })),
        AnyMessage::Response(ServerResponse::TakeoverRequested(TakeoverRequested {
            request_id: "takeover-1".to_string(),
            project_path: "/srv/shop".to_string(),
            requester_label: "laptop".to_string(),
        })),
    ];
    samples.extend(session_messages());
    samples.extend(task_messages());
    samples.extend(pipeline_messages());
    samples.extend(prompt_messages());
    samples.extend(import_messages());
    samples
}

/// A session's traffic and the agent queries around it, one of each variant.
fn session_messages() -> Vec<AnyMessage> {
    vec![
        AnyMessage::Request(ServerRequest::Handshake(HandshakeRequest {
            protocol_version: PROTOCOL_VERSION,
        })),
        AnyMessage::Response(ServerResponse::HandshakeOk(HandshakeResponse {
            protocol_version: PROTOCOL_VERSION,
        })),
        AnyMessage::Request(ServerRequest::Prompt(PromptRequest {
            session_id: "session".to_string(),
            content: serde_json::Value::String("fix the bug in auth.rs".to_string()),
        })),
        AnyMessage::Request(ServerRequest::Cancel(CancelRequest {
            session_id: "session".to_string(),
        })),
        AnyMessage::Request(ServerRequest::InterruptTurn(InterruptTurnRequest {
            session_id: "session".to_string(),
        })),
        AnyMessage::Response(ServerResponse::SpawnOk(SpawnResponse {
            session_id: "session".to_string(),
            acp_session_id: Some("native-uuid-123".to_string()),
            prompt_capabilities: Some(PromptCapabilitiesInfo {
                embedded_context: true,
                image: false,
                audio: false,
            }),
            modes: Some(SessionModeState {
                current_mode_id: "default".to_string(),
                available_modes: vec![ModeInfo {
                    mode_id: "acceptEdits".to_string(),
                    name: "Edit automatically".to_string(),
                    description: Some("File ops auto-approved".to_string()),
                }],
            }),
            models: Some(SessionModelState {
                current_model_id: "claude-sonnet-4-6".to_string(),
                available_models: vec![ModelInfo {
                    model_id: "claude-opus-4-7".to_string(),
                    name: "Opus 4.7".to_string(),
                    description: None,
                }],
            }),
            supports_session_list: false,
            supports_session_load: true,
            supports_session_close: false,
            supports_session_delete: false,
            config_options: None,
        })),
        AnyMessage::Request(ServerRequest::SetModel(SetModelRequest {
            session_id: "session".to_string(),
            model_id: "claude-opus-4-7".to_string(),
        })),
        AnyMessage::Request(ServerRequest::SetMode(SetModeRequest {
            session_id: "session".to_string(),
            mode_id: "plan".to_string(),
        })),
        AnyMessage::Response(ServerResponse::SetModeOk(SetModeOkResponse {
            session_id: "session".to_string(),
            mode_id: "plan".to_string(),
        })),
        AnyMessage::Response(ServerResponse::PermissionRequest(PermissionRequest {
            session_id: "session".to_string(),
            request_id: "perm-42".to_string(),
            payload: serde_json::json!({"tool": "write_file", "path": "/tmp/foo.txt"}),
        })),
        AnyMessage::Request(ServerRequest::PermitResponse(PermissionResponse {
            session_id: "session".to_string(),
            request_id: "perm-42".to_string(),
            option_id: Some("default".into()),
        })),
        AnyMessage::Request(ServerRequest::PermitResponse(PermissionResponse {
            session_id: "session".to_string(),
            request_id: "perm-43".to_string(),
            option_id: None,
        })),
        AnyMessage::Request(ServerRequest::FileSearch(FileSearchRequest {
            cwd: "/home/user/project".to_string(),
            query: "main".to_string(),
            limit: Some(20),
        })),
        AnyMessage::Response(ServerResponse::FileSearchOk(FileSearchResponse {
            files: vec!["src/main.rs".to_string(), "src/lib.rs".to_string()],
        })),
        AnyMessage::Request(ServerRequest::FileRead(FileReadRequest {
            cwd: "/home/user/project".to_string(),
            relative_path: "src/main.rs".to_string(),
        })),
        AnyMessage::Response(ServerResponse::FileReadOk(FileReadResponse {
            content: "fn main() {}".to_string(),
        })),
        AnyMessage::Response(ServerResponse::TurnStarted(TurnStarted {
            session_id: "session".to_string(),
        })),
        AnyMessage::Response(ServerResponse::TurnEnded(TurnEnded {
            session_id: "session".to_string(),
            stop_reason: "end_turn".to_string(),
            usage: Some(TurnUsage {
                total_tokens: 30,
                input_tokens: 10,
                output_tokens: 20,
                thought_tokens: None,
                cached_read_tokens: Some(5),
                cached_write_tokens: None,
            }),
            model_usage: Some(serde_json::json!([{ "model": "m", "token_count": { "x": 1 } }])),
        })),
        AnyMessage::Response(ServerResponse::UsageTurnsOk(UsageTurnsResponse {
            store_id: "s".to_string(),
            merged_through_id: 3,
            turns: vec![UsageTurnRow {
                id: 4,
                agent_id: "claude-acp".to_string(),
                acp_session_id: "a".to_string(),
                project_path: "/p".to_string(),
                model_id: Some("opus".to_string()),
                started_at: "2026-10-12T10:00:00Z".to_string(),
                ended_at: "2026-10-12T10:00:30Z".to_string(),
                tokens: UsageTokens {
                    total_tokens: Some(30),
                    input_tokens: Some(10),
                    ..Default::default()
                },
                cost_amount: Some(0.5),
                cost_currency: Some("USD".to_string()),
            }],
            models: vec![UsageTurnModelRow {
                turn_id: 4,
                model: "claude-opus".to_string(),
                tokens: UsageTokens {
                    input_tokens: Some(10),
                    ..Default::default()
                },
            }],
            more: false,
        })),
        AnyMessage::Request(ServerRequest::PreInitialize(PreInitializeRequest {
            agent_id: "claude-acp".to_string(),
            cwd: "/home/user/project".to_string(),
        })),
        AnyMessage::Response(ServerResponse::PreInitializeOk(PreInitializeResponse {
            agent_id: "claude-acp".to_string(),
            prompt_capabilities: None,
            supports_session_list: true,
            supports_session_load: true,
            supports_session_close: false,
            supports_session_delete: false,
            auth_methods: vec![],
            supports_auth_logout: false,
        })),
        AnyMessage::Request(ServerRequest::DetectInstalledAgents(
            DetectInstalledAgentsRequest {},
        )),
        AnyMessage::Response(ServerResponse::DetectInstalledAgentsOk(
            DetectInstalledAgentsResponse {
                agents: vec![DetectedAgentInfo {
                    agent_id: "claude-acp".to_string(),
                    tool_name: "Claude Code".to_string(),
                    binary_found: true,
                    binary_path: Some("/usr/local/bin/claude".to_string()),
                    config_dir_found: true,
                }],
                all_checked_ids: vec!["claude-acp".to_string(), "codex-acp".to_string()],
            },
        )),
        AnyMessage::Request(ServerRequest::Pong { seq: 42 }),
        AnyMessage::Response(ServerResponse::HostToolCall(HostToolCall {
            session_id: "session".to_string(),
            request_id: "host-1".to_string(),
            name: "create_task".to_string(),
            arguments: serde_json::json!({"title": "Add retries to SFTP reads"}),
        })),
        AnyMessage::Request(ServerRequest::HostToolResult(HostToolResult {
            session_id: "session".to_string(),
            request_id: "host-1".to_string(),
            result: serde_json::json!({"id": 12, "status": "Planning"}),
            error: None,
        })),
        AnyMessage::Request(ServerRequest::HostToolResult(HostToolResult {
            session_id: "session".to_string(),
            request_id: "host-2".to_string(),
            result: serde_json::Value::Null,
            error: Some("unknown tool".to_string()),
        })),
        AnyMessage::Response(ServerResponse::Diagnostic(DiagnosticPayload {
            level: "error".to_string(),
            message: "[spawn] FAILED cmd=\"claude\": No such file".to_string(),
        })),
    ]
}

fn import_messages() -> Vec<AnyMessage> {
    vec![
        AnyMessage::Request(ServerRequest::BeginImport(BeginImportRequest {
            project_path: "/srv/shop".to_string(),
            floors: ImportFloors {
                tasks: Some(12),
                ..ImportFloors::default()
            },
            source_id: Some("install-1".to_string()),
        })),
        AnyMessage::Response(ServerResponse::BeginImportOk(BeginImportResponse {
            import_id: "import-1".to_string(),
            imported_before: false,
            merge: true,
            task_offset: 40,
        })),
        AnyMessage::Response(ServerResponse::ImportChunkOk),
        AnyMessage::Request(ServerRequest::CommitImport(ImportRef {
            import_id: "import-1".to_string(),
        })),
        AnyMessage::Request(ServerRequest::ImportChunk(ImportChunkRequest {
            import_id: "import-1".to_string(),
            chunk: sample_import(),
        })),
        AnyMessage::Response(ServerResponse::ImportProjectOk(ImportProjectResponse {
            imported: false,
        })),
    ]
}

fn sample_import() -> ImportProjectRequest {
    ImportProjectRequest {
        project_path: "/srv/shop".to_string(),
        tasks: vec![sample_task()],
        relationships: vec![],
        instructions: vec![],
        comments: vec![TaskComment {
            id: 8,
            task_id: 3,
            kind: "outcome".to_string(),
            author: "agent".to_string(),
            body: Some("Done".to_string()),
            external_ref: None,
            phase: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
        }],
        attachments: vec![],
        worktrees: vec![],
        reviews: vec![TaskReview {
            id: 2,
            task_id: 3,
            decision: "RequestChanges".to_string(),
            general_feedback: None,
            reviewed_at: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            comments: vec![ReviewComment {
                id: 5,
                review_id: 2,
                file_path: "src/lib.rs".to_string(),
                comment: "Name this".to_string(),
                created_at: "2026-01-01T00:00:00Z".to_string(),
            }],
        }],
        prompts: vec![sample_prompt()],
        sessions: vec![ImportedSession {
            agent_id: "claude-acp".to_string(),
            acp_session_id: "acp-1".to_string(),
            cwd: "/srv/shop".to_string(),
            meta: sample_meta(),
            can_reload: None,
            closed: true,
        }],
        floors: ImportFloors::default(),
    }
}

#[test]
fn an_import_answer_is_a_reply() {
    assert!(ServerResponse::ImportProjectOk(ImportProjectResponse { imported: true }).is_reply());
}

#[test]
fn an_import_larger_than_a_frame_splits_into_chunks_under_budget() {
    let mut request = sample_import();
    let row = request.tasks.remove(0);
    let comment = request.comments.remove(0);
    for id in 0..9_000 {
        let mut task = row.clone();
        task.id = id;
        task.description = Some("x".repeat(2_000));
        request.tasks.push(task);
        let mut comment = comment.clone();
        comment.task_id = id;
        request.comments.push(comment);
    }
    let total = serde_json::to_vec(&request).unwrap().len();
    assert!(total > MAX_MESSAGE_SIZE, "{total}");

    let budget = IMPORT_CHUNK_BYTES;
    let chunks = split_import(
        serde_json::from_slice(&serde_json::to_vec(&request).unwrap()).unwrap(),
        budget,
    );
    assert!(chunks.len() > 4, "{}", chunks.len());
    let mut joined = ImportProjectRequest {
        project_path: request.project_path.clone(),
        ..ImportProjectRequest::default()
    };
    for chunk in chunks {
        let message = ServerRequest::ImportChunk(ImportChunkRequest {
            import_id: "00000000-0000-4000-8000-000000000000".to_string(),
            chunk,
        });
        let frame = encode_message(Some(u64::MAX), &message).unwrap();
        assert!(frame.len() < budget, "{}", frame.len());
        let ServerRequest::ImportChunk(ImportChunkRequest { chunk, .. }) = message else {
            unreachable!()
        };
        assert_eq!(chunk.project_path, request.project_path);
        joined.tasks.extend(chunk.tasks);
        joined.relationships.extend(chunk.relationships);
        joined.instructions.extend(chunk.instructions);
        joined.comments.extend(chunk.comments);
        joined.attachments.extend(chunk.attachments);
        joined.worktrees.extend(chunk.worktrees);
        joined.reviews.extend(chunk.reviews);
        joined.prompts.extend(chunk.prompts);
        joined.sessions.extend(chunk.sessions);
    }
    assert_eq!(joined, request);
}

fn sample_prompt() -> Prompt {
    Prompt {
        id: 3,
        project_path: "/srv/shop".to_string(),
        title: "Review".to_string(),
        body: "Review the diff".to_string(),
        tags: vec!["review".to_string()],
        favorite: true,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        updated_at: "2026-01-02T00:00:00Z".to_string(),
    }
}

fn prompt_messages() -> Vec<AnyMessage> {
    let prompt = PromptRef {
        project_path: "/srv/shop".to_string(),
        prompt_id: 3,
    };
    vec![
        AnyMessage::Request(ServerRequest::ListPrompts(ProjectRef {
            project_path: "/srv/shop".to_string(),
        })),
        AnyMessage::Request(ServerRequest::CreatePrompt(CreatePromptRequest {
            project_path: "/srv/shop".to_string(),
            title: "Review".to_string(),
            body: "Review the diff".to_string(),
            tags: vec!["review".to_string()],
            favorite: true,
        })),
        AnyMessage::Request(ServerRequest::UpdatePrompt(UpdatePromptRequest {
            project_path: "/srv/shop".to_string(),
            prompt_id: 3,
            title: "Review".to_string(),
            body: "Review the diff".to_string(),
            tags: vec![],
        })),
        AnyMessage::Request(ServerRequest::SetPromptFavorite(SetPromptFavoriteRequest {
            project_path: "/srv/shop".to_string(),
            prompt_id: 3,
            favorite: false,
        })),
        AnyMessage::Request(ServerRequest::DeletePrompt(prompt)),
        AnyMessage::Response(ServerResponse::ListPromptsOk(PromptList {
            prompts: vec![sample_prompt()],
        })),
        AnyMessage::Response(ServerResponse::GetPromptOk(OptionalPrompt { prompt: None })),
        AnyMessage::Response(ServerResponse::CreatePromptOk(sample_prompt())),
        AnyMessage::Response(ServerResponse::DeletePromptOk),
        AnyMessage::Response(ServerResponse::PromptsChanged(ProjectRef {
            project_path: "/srv/shop".to_string(),
        })),
    ]
}

#[test]
fn prompt_pushes_are_not_replies_and_prompt_answers_are() {
    assert!(!ServerResponse::PromptsChanged(ProjectRef {
        project_path: "/srv/shop".to_string(),
    })
    .is_reply());
    assert!(ServerResponse::SetPromptFavoriteOk(sample_prompt()).is_reply());
    assert!(ServerResponse::DeletePromptOk.is_reply());
}

fn sample_task() -> Task {
    Task {
        id: 3,
        project_path: "/srv/shop".to_string(),
        title: "Fix login".to_string(),
        description: Some("It fails".to_string()),
        status: TaskStatus::Review,
        priority: TaskPriority::High,
        base_branch: "main".to_string(),
        archived_at: None,
        external_id: Some("jira:SHOP-1".to_string()),
        is_imported: Some(true),
        import_source: Some("jira".to_string()),
        skills: vec!["rust".to_string()],
        model_override: None,
        run_mode: RunMode::Pipeline,
        loop_config: None,
        loop_summary: None,
        gate: None,
        drafted_by: None,
        mcp_allowlist: Some(vec!["maestro".to_string()]),
        skills_override: None,
        labels: vec!["bug".to_string()],
        external_url: None,
        external_updated_at: None,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        updated_at: "2026-01-02T00:00:00Z".to_string(),
        auto_approve: false,
        workspace_mode: WorkspaceMode::ReuseWorkspace,
        workspace_worktree_id: Some(4),
        workspace_branch_mode: BranchMode::Create,
        workspace_branch: None,
        agent_id: Some("claude-acp".to_string()),
        permission_mode_override: None,
        execution_start_sha: Some("abc123".to_string()),
        phase: Some(TaskPhase::AwaitingMerge),
        phase_status: Some(PhaseStatus::Waiting),
        ball: TaskBall::External,
        completion: None,
        execute_requested_at: None,
        pull_request_url: Some("https://example.com/pr/9".to_string()),
        pull_request_number: Some(9),
        review_rounds: 1,
        fix_rounds: 0,
        pull_request_ci: Some(PullRequestCi::Pending),
        profile_overrides: Some(r#"{"Planner":null}"#.to_string()),
        claimed_from: None,
    }
}

/// Payloads carrying an `id` of their own, a transition with a guard, a composite step and a
/// push, which is what the `rpc_id` round trip and `is_reply` have to hold for.
fn task_messages() -> Vec<AnyMessage> {
    vec![
        AnyMessage::Response(ServerResponse::CreateTaskOk(sample_task())),
        AnyMessage::Response(ServerResponse::GetTaskOk(OptionalTask { task: None })),
        AnyMessage::Request(ServerRequest::UpdateTask(UpdateTaskRequest {
            project_path: "/srv/shop".to_string(),
            task_id: 3,
            update: TaskUpdate {
                title: Some("Fix login".to_string()),
                description: Some(None),
                status: Some(TaskStatus::Queue),
                pull_request_ci: Some(None),
                execution_start_sha: Some(Some("abc123".to_string())),
                increment_fix_rounds: true,
                ..TaskUpdate::default()
            },
        })),
        AnyMessage::Request(ServerRequest::ApplyTaskTransition(
            ApplyTaskTransitionRequest {
                project_path: "/srv/shop".to_string(),
                task_id: 3,
                event: TaskTransition::TurnCompleted {
                    is_git_repo: true,
                    has_changes: None,
                    reviewer_pending: false,
                },
                guard: TransitionGuard::Status(vec![TaskStatus::Planning, TaskStatus::Queue]),
                update: None,
                comment: None,
            },
        )),
        AnyMessage::Request(ServerRequest::ApplyTaskTransition(
            ApplyTaskTransitionRequest {
                project_path: "/srv/shop".to_string(),
                task_id: 3,
                event: TaskTransition::SessionReady(AgentRole::Coder),
                guard: TransitionGuard::Phase(TaskPhase::SelfReview),
                update: None,
                comment: None,
            },
        )),
        AnyMessage::Request(ServerRequest::ApplyTaskTransition(
            ApplyTaskTransitionRequest {
                project_path: "/srv/shop".to_string(),
                task_id: 3,
                event: TaskTransition::CiFixRequested,
                guard: TransitionGuard::FixRoundsBelow(3),
                update: Some(TaskUpdate {
                    increment_fix_rounds: true,
                    execution_start_sha_if_empty: Some("abc123".to_string()),
                    ..TaskUpdate::default()
                }),
                comment: Some(NewTaskComment {
                    kind: "ci".to_string(),
                    author: "maestro".to_string(),
                    body: Some("CI failed".to_string()),
                    external_ref: None,
                    phase: Some("AwaitingMerge".to_string()),
                }),
            },
        )),
        AnyMessage::Request(ServerRequest::AddTaskComment(AddTaskCommentRequest {
            project_path: "/srv/shop".to_string(),
            task_id: 3,
            comment: NewTaskComment {
                kind: "plan".to_string(),
                author: "agent".to_string(),
                body: Some("Plan".to_string()),
                external_ref: None,
                phase: None,
            },
        })),
        AnyMessage::Request(ServerRequest::ApplyTaskTransition(
            ApplyTaskTransitionRequest {
                project_path: "/srv/shop".to_string(),
                task_id: 3,
                event: TaskTransition::Stopped,
                guard: TransitionGuard::Always,
                update: None,
                comment: None,
            },
        )),
        AnyMessage::Response(ServerResponse::InsertWorktreeOk(Worktree {
            id: 4,
            project_path: "/srv/shop".to_string(),
            task_id: None,
            branch_name: "maestro/3-fix-login".to_string(),
            base_branch: Some("main".to_string()),
            path: String::new(),
            git_status: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
        })),
        AnyMessage::Response(ServerResponse::TasksChanged(ProjectRef {
            project_path: "/srv/shop".to_string(),
        })),
        AnyMessage::Response(ServerResponse::TaskCommentsChanged(TaskRef {
            project_path: "/srv/shop".to_string(),
            task_id: 3,
        })),
    ]
}

#[test]
fn roundtrip_task_messages() {
    for message in task_messages() {
        let json = serde_json::to_string(&message).unwrap();
        let back: AnyMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(message, back);
        assert_eq!(message.session_id(), None);
    }
}

fn pipeline_messages() -> Vec<AnyMessage> {
    vec![
        AnyMessage::Request(ServerRequest::GetCapacity),
        AnyMessage::Request(ServerRequest::SetCapacity(CapacitySettings {
            concurrency_mode: ConcurrencyMode::Hard,
            max_concurrent_agents: 2,
        })),
        AnyMessage::Response(ServerResponse::GetCapacityOk(CapacityStatus {
            settings: CapacitySettings {
                concurrency_mode: ConcurrencyMode::Auto,
                max_concurrent_agents: 3,
            },
            slots: 4,
            reason: "4 slots, 2.6 GB free".to_string(),
            stored: true,
            used: 1,
        })),
        AnyMessage::Request(ServerRequest::SetAutoMode(AutoModeSetting {
            project_path: "/srv/shop".to_string(),
            enabled: true,
        })),
        AnyMessage::Request(ServerRequest::HoldTask(HoldTaskRequest {
            project_path: "/srv/shop".to_string(),
            task_id: 3,
            ttl_ms: None,
        })),
        AnyMessage::Request(ServerRequest::ReleaseTaskHold(TaskRef {
            project_path: "/srv/shop".to_string(),
            task_id: 3,
        })),
        AnyMessage::Request(ServerRequest::StartTask(StartTaskRequest {
            project_path: "/srv/shop".to_string(),
            task_id: 3,
            role: AgentRole::Planner,
            feedback: Some("Split the migration out".to_string()),
            unattended: false,
            respect_capacity: true,
            agent_id: Some("codex-acp".to_string()),
        })),
        AnyMessage::Response(ServerResponse::StartTaskOk(StartTaskResponse {
            session_id: Some("session-9".to_string()),
            skipped_attachments: vec!["spec.pdf: not found".to_string()],
        })),
        AnyMessage::Response(ServerResponse::PipelineSettingsChanged(
            PipelineSettingsChanged { project_path: None },
        )),
        AnyMessage::Response(ServerResponse::TaskSessionStarted(TaskSessionStarted {
            project_path: "/srv/shop".to_string(),
            task_id: 3,
            session_id: "session-9".to_string(),
            agent_id: "claude-acp".to_string(),
            acp_session_id: "conversation-9".to_string(),
            role: AgentRole::Coder,
        })),
    ]
}

#[test]
fn roundtrip_pipeline_messages() {
    for message in pipeline_messages() {
        let json = serde_json::to_string(&message).unwrap();
        let back: AnyMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(message, back);
        // A started session is broadcast: nobody owns it until a window adopts it.
        assert_eq!(message.session_id(), None);
    }
}

#[test]
fn auth_required_for_names_the_agent() {
    let message = auth_required_for("claude-acp");
    assert_eq!(message, "auth_required:claude-acp");
    assert_eq!(
        message.strip_prefix(&format!("{AUTH_REQUIRED_ERROR}:")),
        Some("claude-acp")
    );
}

#[test]
fn start_task_defaults_what_the_button_leaves_out() {
    let json =
        r#"{"request":{"start_task":{"project_path":"/srv/shop","task_id":3,"role":"Coder"}}}"#;
    let AnyMessage::Request(ServerRequest::StartTask(request)) =
        serde_json::from_str(json).unwrap()
    else {
        panic!("not a start_task");
    };
    assert_eq!(request.feedback, None);
    assert!(!request.unattended && !request.respect_capacity);
    assert_eq!(request.agent_id, None);
}

#[test]
fn pipeline_pushes_are_not_replies_and_answers_are() {
    assert!(!ServerResponse::TaskSessionStarted(TaskSessionStarted {
        project_path: "/srv/shop".to_string(),
        task_id: 3,
        session_id: "s".to_string(),
        agent_id: "a".to_string(),
        acp_session_id: "c".to_string(),
        role: AgentRole::Coder,
    })
    .is_reply());
    assert!(
        !ServerResponse::PipelineSettingsChanged(PipelineSettingsChanged {
            project_path: Some("/srv/shop".to_string()),
        })
        .is_reply()
    );
    assert!(ServerResponse::StartTaskOk(StartTaskResponse {
        session_id: None,
        skipped_attachments: vec![],
    })
    .is_reply());
    assert!(ServerResponse::HoldTaskOk.is_reply());
}

#[test]
fn task_pushes_are_not_replies_and_task_answers_are() {
    assert!(!ServerResponse::TasksChanged(ProjectRef {
        project_path: "/srv/shop".to_string(),
    })
    .is_reply());
    assert!(!ServerResponse::WorktreesChanged(ProjectRef {
        project_path: "/srv/shop".to_string(),
    })
    .is_reply());
    assert!(ServerResponse::DeleteWorktreesOk.is_reply());
}

/// `null` clears a column and an absent key leaves it alone, which a plain `Option<Option<_>>`
/// cannot tell apart on the way in.
#[test]
fn task_update_tells_a_cleared_column_from_an_untouched_one() {
    let json = r#"{"request":{"update_task":{"project_path":"/srv/shop","task_id":3,"update":{"pull_request_ci":null,"description":"New"}}}}"#;
    let AnyMessage::Request(ServerRequest::UpdateTask(request)) =
        serde_json::from_str(json).unwrap()
    else {
        panic!("expected an update_task request");
    };
    assert_eq!(request.update.pull_request_ci, Some(None));
    assert_eq!(request.update.description, Some(Some("New".to_string())));
    assert_eq!(request.update.execution_start_sha, None);
    assert!(!request.update.increment_fix_rounds);
}

#[test]
fn a_transition_without_a_guard_is_unguarded() {
    let json = r#"{"request":{"apply_task_transition":{"project_path":"/srv/shop","task_id":3,"event":{"ManualMove":"Queue"}}}}"#;
    let AnyMessage::Request(ServerRequest::ApplyTaskTransition(request)) =
        serde_json::from_str(json).unwrap()
    else {
        panic!("expected an apply_task_transition request");
    };
    assert_eq!(request.event, TaskTransition::ManualMove(TaskStatus::Queue));
    assert_eq!(request.guard, TransitionGuard::Always);
}

async fn round_trips_with_id<M: Message + PartialEq + std::fmt::Debug>(
    id: Option<RequestId>,
    message: M,
) {
    let frame = encode_message(id, &message).unwrap();
    let body = &frame[MSG_LEN_SIZE..];
    assert_eq!(
        body.len(),
        u32::from_le_bytes(frame[..4].try_into().unwrap()) as usize
    );
    let json: serde_json::Value = serde_json::from_slice(body).unwrap();
    assert_eq!(json.get("rpc_id").and_then(|value| value.as_u64()), id);

    let (read_id, read) = read_message_with_id::<M, _>(&mut frame.as_slice())
        .await
        .unwrap();
    let (sync_id, sync) = read_message_with_id_sync::<M, _>(&mut frame.as_slice()).unwrap();
    assert_eq!((read_id, sync_id), (id, id));
    assert_eq!(read, sync);

    // The id-unaware readers must keep working against a peer that sends ids.
    let plain: M = read_message(&mut frame.as_slice()).await.unwrap();
    assert_eq!(plain, read);
    assert_eq!(decode_message(body).unwrap(), (id, message));
}

#[tokio::test]
async fn request_id_round_trips_with_and_without_id() {
    for id in [None, Some(0), Some(u64::MAX)] {
        for message in id_samples() {
            match message {
                AnyMessage::Request(request) => round_trips_with_id(id, request).await,
                AnyMessage::Response(response) => round_trips_with_id(id, response).await,
            }
        }
    }
}

async fn writes_what_it_encodes<M: Message + PartialEq + std::fmt::Debug>(message: M) {
    let mut written = Vec::new();
    write_message(&mut written, &message).await.unwrap();
    assert_eq!(written, encode_message(None, &message).unwrap());
    assert_eq!(
        read_message_with_id(&mut written.as_slice()).await.unwrap(),
        (None, message)
    );
}

#[tokio::test]
async fn write_message_writes_an_id_less_frame() {
    for message in id_samples() {
        match message {
            AnyMessage::Request(request) => writes_what_it_encodes(request).await,
            AnyMessage::Response(response) => writes_what_it_encodes(response).await,
        }
    }
}

/// A frame says which way it goes, so one read by the wrong side fails instead of decoding
/// as some variant of the other enum.
#[test]
fn a_frame_only_decodes_as_its_own_direction() {
    let request = encode_message(Some(1), &ServerRequest::Shutdown).unwrap();
    let response = encode_message(Some(1), &ServerResponse::SessionCloseOk).unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&request[MSG_LEN_SIZE..]).unwrap(),
        serde_json::json!({"rpc_id": 1, "request": "shutdown"})
    );
    assert!(decode_message::<ServerResponse>(&request[MSG_LEN_SIZE..]).is_err());
    assert!(decode_message::<ServerRequest>(&response[MSG_LEN_SIZE..]).is_err());
}

#[test]
fn is_reply_separates_answers_from_pushes() {
    assert!(ServerResponse::SessionCloseOk.is_reply());
    assert!(ServerResponse::Error(ErrorResponse {
        message: "no".to_string(),
        session_id: None,
    })
    .is_reply());
    assert!(ServerResponse::HandshakeOk(HandshakeResponse {
        protocol_version: PROTOCOL_VERSION,
    })
    .is_reply());
    assert!(!ServerResponse::Ping { seq: 1 }.is_reply());
    assert!(!ServerResponse::ProjectLocksChanged.is_reply());
    assert!(!ServerResponse::TerminalOutput(TerminalOutput {
        session_id: "session".to_string(),
        terminal_id: "terminal".to_string(),
        bytes: vec![1],
    })
    .is_reply());
}

fn sample_meta() -> SessionMeta {
    SessionMeta {
        session_name: Some("Fix login".to_string()),
        task_id: Some(7),
        task_name: Some("Login".to_string()),
        branch_name: Some("maestro/login".to_string()),
        session_start_sha: Some("abc123".to_string()),
        role: Some("Coder".to_string()),
    }
}

fn project_session_messages() -> Vec<AnyMessage> {
    let live = ProjectSession {
        agent_id: "claude-acp".to_string(),
        acp_session_id: "conversation-1".to_string(),
        cwd: "/srv/shop".to_string(),
        meta: sample_meta(),
        can_reload: true,
        closed: false,
        live: Some(LiveSessionState {
            session_id: "routing-1".to_string(),
            turn_active: true,
            pending_requests: Vec::new(),
        }),
    };
    let dormant = ProjectSession {
        meta: SessionMeta::default(),
        closed: true,
        live: None,
        ..live.clone()
    };
    vec![
        AnyMessage::Request(ServerRequest::Spawn(SpawnRequest {
            agent_id: "claude-acp".to_string(),
            session_id: "routing-1".to_string(),
            cwd: "/srv/shop".to_string(),
            additional_directories: Vec::new(),
            project_path: Some("/srv/shop".to_string()),
            meta: sample_meta(),
        })),
        AnyMessage::Request(ServerRequest::SessionLoad(SessionLoadRequest {
            agent_id: "claude-acp".to_string(),
            session_id: "routing-1".to_string(),
            resume_session_id: "conversation-1".to_string(),
            cwd: "/srv/shop".to_string(),
            additional_directories: Vec::new(),
            project_path: Some("/srv/shop".to_string()),
            meta: sample_meta(),
        })),
        AnyMessage::Request(ServerRequest::ListProjectSessions(
            ListProjectSessionsRequest {
                project_path: "/srv/shop".to_string(),
                include_closed: true,
            },
        )),
        AnyMessage::Request(ServerRequest::RenameSession(RenameSessionRequest {
            project_path: "/srv/shop".to_string(),
            agent_id: "claude-acp".to_string(),
            acp_session_id: "conversation-1".to_string(),
            cwd: "/srv/shop".to_string(),
            name: "Fix login".to_string(),
        })),
        AnyMessage::Response(ServerResponse::ListProjectSessionsOk(
            ListProjectSessionsResponse {
                sessions: vec![live, dormant],
            },
        )),
        AnyMessage::Response(ServerResponse::RenameSessionOk),
        AnyMessage::Request(ServerRequest::CloseProjectSession(
            CloseProjectSessionRequest {
                agent_id: "claude-acp".to_string(),
                acp_session_id: "conversation-1".to_string(),
            },
        )),
        AnyMessage::Response(ServerResponse::CloseProjectSessionOk),
    ]
}

#[test]
fn roundtrip_project_session_messages() {
    for message in project_session_messages() {
        let json = serde_json::to_string(&message).unwrap();
        let back: AnyMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(message, back);
    }
}

#[test]
fn roundtrip_home_summary() {
    let request = AnyMessage::Request(ServerRequest::HomeSummary(HomeSummaryRequest {
        project_paths: vec!["/srv/shop".to_string()],
    }));
    let response = ServerResponse::HomeSummaryOk(HomeSummaryResponse {
        status: ServerStatus {
            version: "1.0.0".to_string(),
            pid: 7,
            started_at: "2026-10-05T09:00:00Z".to_string(),
            live_sessions: 2,
            running_runs: 1,
            autostart_supported: true,
            autostart: None,
        },
        projects: vec![
            ProjectSummary {
                project_path: "/srv/shop".to_string(),
                queued: 1,
                in_progress: 2,
                review: 3,
                working_agents: 1,
                needs_you: 2,
                blocking_prompt: Some("Run cargo test?".to_string()),
                running_automations: vec!["Nightly".to_string()],
                lock_holder: Some("laptop".to_string()),
                lock_yours: true,
            },
            ProjectSummary {
                project_path: "/srv/idle".to_string(),
                ..ProjectSummary::default()
            },
        ],
    });
    assert!(response.is_reply());
    for message in [request, AnyMessage::Response(response)] {
        let json = serde_json::to_string(&message).unwrap();
        let back: AnyMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(message, back);
    }
}

#[test]
fn spawn_request_without_project_keys_still_deserializes() {
    let json =
        r#"{"request":{"spawn":{"agent_id":"claude-acp","session_id":"sess-1","cwd":"/tmp"}}}"#;
    let AnyMessage::Request(ServerRequest::Spawn(request)) = serde_json::from_str(json).unwrap()
    else {
        panic!("expected a spawn request");
    };
    assert_eq!(request.project_path, None);
    assert_eq!(request.meta, SessionMeta::default());
}

#[test]
fn project_session_requests_are_not_session_routed_and_responses_are_replies() {
    for message in project_session_messages() {
        match &message {
            AnyMessage::Request(
                ServerRequest::ListProjectSessions(_)
                | ServerRequest::RenameSession(_)
                | ServerRequest::CloseProjectSession(_),
            ) => assert_eq!(message.session_id(), None),
            AnyMessage::Response(response) => {
                assert!(response.is_reply());
                assert_eq!(message.session_id(), None);
            }
            AnyMessage::Request(_) => {}
        }
    }
}

#[test]
fn request_and_response_are_distinguishable() {
    // Verify that a Spawn request and a SpawnOk response both containing session_id
    // are correctly distinguished by the outer `request`/`response` key
    let req = AnyMessage::Request(ServerRequest::Spawn(SpawnRequest {
        agent_id: "test".to_string(),
        session_id: "sess-1".to_string(),
        cwd: "/tmp".to_string(),
        additional_directories: Vec::new(),
        project_path: None,
        meta: SessionMeta::default(),
    }));
    let resp = AnyMessage::Response(ServerResponse::SpawnOk(SpawnResponse {
        session_id: "sess-1".to_string(),
        acp_session_id: None,
        models: None,
        modes: None,
        prompt_capabilities: None,
        supports_session_list: false,
        supports_session_load: false,
        supports_session_close: false,
        supports_session_delete: false,
        config_options: None,
    }));
    let req_json = serde_json::to_string(&req).unwrap();
    let resp_json = serde_json::to_string(&resp).unwrap();
    // Verify they produce different JSON
    assert_ne!(req_json, resp_json);
    // Verify each round-trips to the correct variant
    let req_back: AnyMessage = serde_json::from_str(&req_json).unwrap();
    let resp_back: AnyMessage = serde_json::from_str(&resp_json).unwrap();
    assert!(matches!(req_back, AnyMessage::Request(_)));
    assert!(matches!(resp_back, AnyMessage::Response(_)));
}
