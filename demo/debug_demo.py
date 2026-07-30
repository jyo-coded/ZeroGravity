"""
A small script for demonstrating 0G's debugger.

Suggested walkthrough:
  1. Click the gutter on line 28 (inside the loop in `score_commit`).
  2. Open Run and Debug (Ctrl+Shift+D) and press Debug.
  3. When it pauses: inspect `commit` in Variables — it is a dict, so it
     expands. `weights` expands too.
  4. Step over (→) a few times to watch `total` accumulate.
  5. Step into (↓) on the `risk_label(...)` call to move down a frame, then
     use the Call stack to jump back up.
  6. Continue (▶) to run to completion and see the output in Console.
"""

WEIGHTS = {
    "files_changed": 2.0,
    "lines_added": 0.05,
    "lines_removed": 0.08,
    "tests_touched": -3.0,
}


def score_commit(commit, weights):
    """Weighted risk score for one commit. Set the breakpoint on line 28."""
    total = 0.0
    for field, weight in weights.items():
        value = commit.get(field, 0)
        contribution = value * weight
        total += contribution
    return round(total, 2)


def risk_label(score):
    """Bucket a score. Good target for 'step into'."""
    if score < 5:
        return "low"
    if score < 15:
        return "moderate"
    return "high"


def main():
    commits = [
        {"sha": "a1b2c3d", "files_changed": 1, "lines_added": 12, "lines_removed": 3, "tests_touched": 1},
        {"sha": "e4f5g6h", "files_changed": 9, "lines_added": 340, "lines_removed": 120, "tests_touched": 0},
        {"sha": "i7j8k9l", "files_changed": 3, "lines_added": 45, "lines_removed": 60, "tests_touched": 2},
    ]

    for commit in commits:
        score = score_commit(commit, WEIGHTS)
        label = risk_label(score)
        print(f"{commit['sha']}  score={score:>7}  risk={label}")


if __name__ == "__main__":
    main()
