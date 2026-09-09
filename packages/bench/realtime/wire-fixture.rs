// SPDX-License-Identifier: MIT
// Copy the pinned MidStream src/reflex.rs beside this file as reflex-under-test.rs.
#[path = "reflex-under-test.rs"]
mod reflex;
use reflex::{ReflexController, ReflexEvent, ReflexEventKind};

fn main() {
    for index in 0..1000_u64 {
        let session = format!("s{index}");
        let sequence = if index == 999 {
            u64::MAX
        } else if index % 3 == 0 {
            9_007_199_254_740_992 + index
        } else {
            index + 2
        };
        let mut controller = ReflexController::new(1);
        controller.observe(
            ReflexEvent {
                sequence: sequence - 1,
                at_micros: 0,
                kind: ReflexEventKind::Observation,
            },
            0,
        );
        let receipt = controller.observe(
            ReflexEvent {
                sequence,
                at_micros: 1,
                kind: if index % 2 == 0 {
                    ReflexEventKind::Interrupt
                } else {
                    ReflexEventKind::Cancel
                },
            },
            7,
        );
        assert_eq!(receipt.authority, "none");
        assert_eq!(controller.queued(), 1);
        println!(
            "{}",
            controller
                .drain_for_reasoner()
                .to_wire_json(&session)
                .expect("valid fixture session")
        );
    }
}
