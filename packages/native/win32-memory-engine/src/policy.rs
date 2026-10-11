//! Target capability probing and the descent ladder.
//!
//! Evidence (real Win32 attempts, nothing inferred) is classified into a
//! [`Capability`]: `MEMORY_ALLOWED` → `INPUT_ONLY` → `VISION_ONLY` → `REFUSED`.
//! The ladder descends only; losing access never climbs back. Refusals are
//! coded and terminal: a refused target triggers no further probes and no
//! side effects.

use serde::Serialize;

use crate::hwnd;
use crate::observer::{self, ProcessReader};
use crate::EngineError;

/// Protection label of the target process. Written from the denial path:
/// `ERROR_ACCESS_DENIED` is distinguished and measured with
/// `GetProcessInformation(ProcessProtectionLevelInfo)`; nothing is swallowed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub enum TargetClass {
    /// Protection level not queried (open succeeded or probe unavailable).
    #[default]
    Unprobed,
    /// No protection level (`PROTECTION_LEVEL_NONE`).
    Normal,
    /// Lightly-protected process family (PPL: antimalware/LSA/codegen/app).
    ProtectedProcessLight,
    /// Fully-protected process family (Windows/WinTCB/Authenticode).
    ProtectedProcess,
    /// Refusing target whose protection level could not be read.
    ProtectedUnknown,
    /// No such process.
    Gone,
}

impl TargetClass {
    /// Whether the target runs under a protection level that forbids VM
    /// access from user mode.
    pub fn is_protected(&self) -> bool {
        matches!(
            self,
            TargetClass::ProtectedProcessLight
                | TargetClass::ProtectedProcess
                | TargetClass::ProtectedUnknown
        )
    }
}

/// Highest honest capability of a target, in ladder order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub enum Capability {
    /// No capability: coded refusal, no probes, no side effects.
    Refused,
    /// External view only (alive but no VM access, no window).
    VisionOnly,
    /// Ham scan-code input to an owned window (VM access closed).
    InputOnly,
    /// Process memory readable and writable through the actuators.
    MemoryAllowed,
}

/// One recorded probe attempt and its outcome (the audit trail).
#[derive(Debug, Clone, Serialize)]
pub struct ProbeAttempt {
    /// Probe name, e.g. `OpenProcess(VM_READ)`.
    pub probe: String,
    /// Outcome, e.g. `granted`, `ERROR_ACCESS_DENIED`, `skipped: target refused`.
    pub outcome: String,
    pub win32: Option<u32>,
}

/// Measured evidence of one target. All fields come from real attempts.
#[derive(Debug, Clone, Default)]
pub struct ProbeEvidence {
    /// `OpenProcess(VM_READ|QUERY_* )` succeeded.
    pub vm_read_open: bool,
    /// Win32 code of the VM read refusal (when refused).
    pub vm_read_win32: Option<u32>,
    /// The process still answers `PROCESS_QUERY_LIMITED_INFORMATION`.
    pub query_open: bool,
    /// Protection label written from the denial path.
    pub class: TargetClass,
    /// The target owns at least one HWND.
    pub window_found: bool,
    /// At least one owned HWND is visible.
    pub window_visible: bool,
}

/// Classification result with its audit trail and coded refusal.
#[derive(Debug, Clone)]
pub struct TargetAssessment {
    pub capability: Capability,
    pub class: TargetClass,
    /// Coded refusal, present exactly when `capability == Refused`.
    pub refusal: Option<EngineError>,
    pub attempts: Vec<ProbeAttempt>,
}

/// Reader plus assessment produced by [`probe_target`].
pub struct TargetProbe {
    /// Present exactly when the capability is [`Capability::MemoryAllowed`].
    pub reader: Option<ProcessReader>,
    pub assessment: TargetAssessment,
}

/// Classify measured evidence (pure; the ladder decision table).
pub fn classify(evidence: &ProbeEvidence) -> TargetAssessment {
    let mut attempts = Vec::new();
    attempts.push(ProbeAttempt {
        probe: "OpenProcess(VM_READ)".to_string(),
        outcome: if evidence.vm_read_open {
            "granted".to_string()
        } else {
            format!(
                "denied (win32 {})",
                evidence
                    .vm_read_win32
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "unknown".to_string())
            )
        },
        win32: evidence.vm_read_win32,
    });
    attempts.push(ProbeAttempt {
        probe: "GetProcessInformation(ProcessProtectionLevelInfo)".to_string(),
        outcome: match evidence.class {
            TargetClass::Unprobed => "unavailable".to_string(),
            class => format!("{class:?}"),
        },
        win32: None,
    });

    if evidence.class == TargetClass::Gone {
        // Yalnızca süreç gerçekten yoksa dur; diğer her durumda keşif devam eder.
        attempts.push(ProbeAttempt {
            probe: "window probe".to_string(),
            outcome: "skipped: target process is gone".to_string(),
            win32: None,
        });
        return TargetAssessment {
            capability: Capability::Refused,
            class: evidence.class,
            refusal: Some(EngineError::NotFound {
                detail: "target process does not exist".to_string(),
            }),
            attempts,
        };
    }

    attempts.push(ProbeAttempt {
        probe: "window probe".to_string(),
        outcome: format!(
            "found={} visible={}",
            evidence.window_found, evidence.window_visible
        ),
        win32: None,
    });
    if evidence.vm_read_open {
        TargetAssessment {
            capability: Capability::MemoryAllowed,
            class: evidence.class,
            refusal: None,
            attempts,
        }
    } else if evidence.window_found && evidence.window_visible {
        TargetAssessment {
            capability: Capability::InputOnly,
            class: evidence.class,
            refusal: None,
            attempts,
        }
    } else {
        TargetAssessment {
            capability: Capability::VisionOnly,
            class: evidence.class,
            refusal: None,
            attempts,
        }
    }
}

/// Descent step: re-classification can only lower the standing capability
/// (lost access, dying window, newly refused target).
pub fn descend(current: Capability, evidence: &ProbeEvidence) -> Capability {
    current.min(classify(evidence).capability)
}

/// Refuse when `actual` is below `needed`; the refusal is coded, never quiet.
pub fn require(actual: Capability, needed: Capability) -> Result<(), EngineError> {
    if actual >= needed {
        Ok(())
    } else {
        Err(EngineError::Rejected {
            detail: format!("capability {actual:?} is below required {needed:?}"),
        })
    }
}

/// Run the honest probe sequence against `pid`:
/// `OpenProcess(VM_READ|QUERY_*)`, then on refusal the protection query and
/// (only while the target still answers) the window probe.
pub fn probe_target(pid: u32) -> TargetProbe {
    let report = observer::open_read(pid);
    let vm_read_open = report.reader.is_some();
    // A fully refused target gets no extra probing ("sessiz deneme yok").
    let query_open = vm_read_open || report.class != TargetClass::Gone;
    let (window_found, window_visible) = if query_open {
        // Window evidence completes the ladder record even when memory is
        // already granted.
        hwnd::probe_window_presence(pid)
    } else {
        (false, false)
    };
    let evidence = ProbeEvidence {
        vm_read_open,
        vm_read_win32: report.win32,
        query_open,
        class: report.class,
        window_found,
        window_visible,
    };
    let assessment = classify(&evidence);
    TargetProbe {
        reader: report.reader,
        assessment,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn denied_evidence(class: TargetClass) -> ProbeEvidence {
        ProbeEvidence {
            vm_read_open: false,
            vm_read_win32: Some(5),
            query_open: true,
            class,
            window_found: false,
            window_visible: false,
        }
    }

    #[test]
    fn vm_read_grant_is_memory_allowed() {
        let evidence = ProbeEvidence {
            vm_read_open: true,
            query_open: true,
            class: TargetClass::Normal,
            window_found: true,
            window_visible: true,
            ..Default::default()
        };
        let assessment = classify(&evidence);
        assert_eq!(assessment.capability, Capability::MemoryAllowed);
        assert!(assessment.refusal.is_none());
    }

    #[test]
    fn denied_vm_with_visible_window_descends_to_input_only() {
        let mut evidence = denied_evidence(TargetClass::ProtectedUnknown);
        evidence.window_found = true;
        evidence.window_visible = true;
        let assessment = classify(&evidence);
        assert_eq!(assessment.capability, Capability::InputOnly);
        assert!(assessment.refusal.is_none());
    }

    #[test]
    fn denied_vm_without_window_is_vision_only() {
        let assessment = classify(&denied_evidence(TargetClass::ProtectedUnknown));
        assert_eq!(assessment.capability, Capability::VisionOnly);
        assert!(assessment.refusal.is_none());
    }

    #[test]
    fn ppl_targets_are_coded_terminal_refusals() {
        let mut evidence = denied_evidence(TargetClass::ProtectedProcessLight);
        evidence.query_open = false;
        evidence.window_found = true;
        evidence.window_visible = true;
        let assessment = classify(&evidence);
        assert_eq!(assessment.capability, Capability::Refused);
        assert!(matches!(
            assessment.refusal,
            Some(EngineError::Protected { .. })
        ));
        // The refusal stops probing: the window probe was not consulted.
        let window_attempts = assessment
            .attempts
            .iter()
            .filter(|attempt| attempt.probe == "window probe")
            .count();
        assert_eq!(window_attempts, 1);
        assert!(assessment.attempts.iter().any(|attempt|
            attempt.outcome == "skipped: target refused"));
    }

    #[test]
    fn gone_targets_refuse_with_not_found() {
        let mut evidence = denied_evidence(TargetClass::Gone);
        evidence.query_open = false;
        let assessment = classify(&evidence);
        assert_eq!(assessment.capability, Capability::Refused);
        assert!(matches!(
            assessment.refusal,
            Some(EngineError::NotFound { .. })
        ));
    }

    #[test]
    fn ladder_only_descends() {
        let mut evidence = ProbeEvidence {
            vm_read_open: true,
            query_open: true,
            class: TargetClass::Normal,
            window_found: true,
            window_visible: true,
            ..Default::default()
        };
        assert_eq!(descend(Capability::MemoryAllowed, &evidence), Capability::MemoryAllowed);
        // Lost VM access drops to input-only even though memory was allowed.
        evidence.vm_read_open = false;
        assert_eq!(descend(Capability::MemoryAllowed, &evidence), Capability::InputOnly);
        // Lost window drops to vision-only.
        evidence.window_visible = false;
        assert_eq!(descend(Capability::InputOnly, &evidence), Capability::VisionOnly);
        // Vanished target drops to refused.
        evidence.query_open = false;
        assert_eq!(descend(Capability::VisionOnly, &evidence), Capability::Refused);
    }

    #[test]
    fn required_capability_gates_commands() {
        assert!(require(Capability::MemoryAllowed, Capability::InputOnly).is_ok());
        assert!(require(Capability::VisionOnly, Capability::InputOnly).is_err());
        assert!(require(Capability::Refused, Capability::VisionOnly).is_err());
    }
}
