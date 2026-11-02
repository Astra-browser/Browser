/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Steps stream: the append-only, versioned event log of a run.
//!
//! Every observable agent action — an observation, a tool call, a model
//! message, an approval checkpoint, a finished summary — is one
//! [`StepEvent`] with a monotonic `seq`. [`StepStream`] is the in-memory
//! skeleton (durable persistence in `astra-store` `agent_steps` arrives with
//! the runtime); it enforces contiguous sequence numbers so a dropped or
//! reordered event fails loudly instead of silently forking history.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Step-event format version. Bump on any breaking shape change and keep
/// [`StepError::VersionMismatch`] so old rows fail loudly, never silently.
pub const STEP_EVENT_VERSION: u32 = 1;

/// Maximum summary text length accepted by [`StepEvent::validate`].
pub const MAX_STEP_SUMMARY_CHARS: usize = 8_000;

/// What kind of work one step records.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepKind {
    /// A page or tool observation fed back into the loop.
    Observe,
    /// A model message (reasoning or reply draft).
    Message,
    /// A tool invocation (see [`crate::tools`]).
    ToolCall,
    /// A tool result delivered back to the loop.
    ToolResult,
    /// An approval checkpoint (see [`crate::approvals`]).
    Approval,
    /// A plan change (see [`crate::planner`]).
    Plan,
    /// Terminal summary of a finished run.
    Done,
}

/// One versioned event in a run's step stream.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StepEvent {
    pub version: u32,
    pub seq: u64,
    pub kind: StepKind,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum StepError {
    #[error("unsupported step event version {0} (expected {1})")]
    VersionMismatch(u32, u32),
    #[error("invalid step event: {0}")]
    Invalid(String),
    #[error("step JSON error: {0}")]
    Json(String),
    #[error("step stream out of order: expected seq {expected}, got {got}")]
    OutOfOrder { expected: u64, got: u64 },
}

impl StepEvent {
    /// New event at sequence number `seq`.
    pub fn new(seq: u64, kind: StepKind, summary: impl Into<String>) -> Self {
        Self {
            version: STEP_EVENT_VERSION,
            seq,
            kind,
            summary: summary.into(),
            detail: None,
        }
    }

    /// Attach machine-readable detail (tool JSON, approval id, ...).
    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    /// Serialize to the string stored in the `agent_steps` row.
    pub fn to_json(&self) -> Result<String, StepError> {
        serde_json::to_string(self).map_err(|e| StepError::Json(e.to_string()))
    }

    /// Parse + version-check + validate.
    pub fn from_json(json: &str) -> Result<Self, StepError> {
        let event: Self = serde_json::from_str(json).map_err(|e| StepError::Json(e.to_string()))?;
        event.validate()?;
        Ok(event)
    }

    /// Structural validation: version and non-empty summary within bounds.
    pub fn validate(&self) -> Result<(), StepError> {
        if self.version != STEP_EVENT_VERSION {
            return Err(StepError::VersionMismatch(self.version, STEP_EVENT_VERSION));
        }
        if self.summary.trim().is_empty() {
            return Err(StepError::Invalid(
                "step summary must not be empty".to_owned(),
            ));
        }
        if self.summary.chars().count() > MAX_STEP_SUMMARY_CHARS {
            return Err(StepError::Invalid(format!(
                "step summary exceeds {MAX_STEP_SUMMARY_CHARS} chars"
            )));
        }
        Ok(())
    }
}

/// In-memory append-only step stream. Sequence numbers must be contiguous
/// from zero: [`StepStream::push`] rejects gaps and replays so a dropped
/// event can never silently fork run history.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StepStream {
    events: Vec<StepEvent>,
}

impl StepStream {
    /// Empty stream.
    pub fn new() -> Self {
        Self { events: Vec::new() }
    }

    /// Append one event. The event's `seq` must equal the stream length.
    pub fn push(&mut self, event: StepEvent) -> Result<(), StepError> {
        event.validate()?;
        let expected = self.events.len() as u64;
        if event.seq != expected {
            return Err(StepError::OutOfOrder {
                expected,
                got: event.seq,
            });
        }
        self.events.push(event);
        Ok(())
    }

    /// Number of events appended.
    pub fn len(&self) -> usize {
        self.events.len()
    }

    /// True when no events have been appended.
    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    /// All events in sequence order.
    pub fn events(&self) -> &[StepEvent] {
        &self.events
    }

    /// Latest event, if any.
    pub fn last(&self) -> Option<&StepEvent> {
        self.events.last()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn step_stream_appends_in_order() {
        let mut stream = StepStream::new();
        assert!(stream.is_empty());
        stream
            .push(StepEvent::new(0, StepKind::Observe, "saw page"))
            .unwrap();
        stream
            .push(
                StepEvent::new(1, StepKind::ToolCall, "read text")
                    .with_detail(r#"{"tool":"page_read"}"#),
            )
            .unwrap();
        assert_eq!(stream.len(), 2);
        assert_eq!(stream.last().unwrap().seq, 1);
        assert_eq!(
            stream.last().unwrap().detail.as_deref(),
            Some(r#"{"tool":"page_read"}"#)
        );
    }

    #[test]
    fn step_stream_rejects_gaps_and_replays() {
        let mut stream = StepStream::new();
        stream
            .push(StepEvent::new(0, StepKind::Observe, "a"))
            .unwrap();
        assert_eq!(
            stream.push(StepEvent::new(2, StepKind::Observe, "gap")),
            Err(StepError::OutOfOrder {
                expected: 1,
                got: 2
            })
        );
        assert_eq!(
            stream.push(StepEvent::new(0, StepKind::Observe, "replay")),
            Err(StepError::OutOfOrder {
                expected: 1,
                got: 0
            })
        );
        assert_eq!(stream.len(), 1);
    }

    #[test]
    fn step_event_json_round_trip_and_version_check() {
        let event = StepEvent::new(3, StepKind::Approval, "ask user");
        let parsed = StepEvent::from_json(&event.to_json().unwrap()).unwrap();
        assert_eq!(parsed, event);

        let mut bad = event.clone();
        bad.version = 999;
        assert_eq!(
            bad.validate(),
            Err(StepError::VersionMismatch(999, STEP_EVENT_VERSION))
        );
        assert!(StepEvent::from_json(&bad.to_json().unwrap()).is_err());
        assert!(matches!(
            StepEvent::from_json("{not json"),
            Err(StepError::Json(_))
        ));

        let bad = StepEvent::new(0, StepKind::Message, "   ");
        assert!(bad.validate().is_err());
    }
}
