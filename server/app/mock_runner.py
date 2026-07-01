from __future__ import annotations

from typing import Any

from server.app.consistency import evaluate_storyboard_consistency


def build_mock_short_drama(prompt: str) -> dict[str, Any]:
    theme = prompt.strip() or "urban reversal short drama"
    characters = [
        {
            "id": "c1",
            "name": "Lin",
            "role": "lead investigator",
            "visual_lock": "red coat, short hair",
            "voice": None,
            "reference_images": [],
            "locked": True,
        },
        {
            "id": "c2",
            "name": "Chen",
            "role": "boss hiding the truth",
            "visual_lock": "black suit, silver glasses",
            "voice": None,
            "reference_images": [],
            "locked": True,
        },
        {
            "id": "c3",
            "name": "Aunt Mei",
            "role": "neighbor with the clue",
            "visual_lock": "gray scarf, warm eyes",
            "voice": None,
            "reference_images": [],
            "locked": False,
        },
    ]
    style_lock = "rainy neon suspense, vertical short drama, high contrast"
    beats = [
        ("Rain-night hook", "Lin in red coat, short hair finds a soaked envelope under neon rain"),
        ("Conflict rises", "Chen in black suit, silver glasses blocks Lin at the office elevator"),
        ("Clue revealed", "Aunt Mei with gray scarf, warm eyes shows Lin a hidden recording"),
        ("Reversal", "Lin in red coat, short hair confronts Chen beside the alley billboard"),
        ("Cliffhanger", "Lin in red coat, short hair walks into dawn holding the evidence"),
    ]

    shots = []
    for index, (beat, shot_prompt) in enumerate(beats, start=1):
        character_ids = ["c1"]
        if index in (2, 4):
            character_ids.append("c2")
        if index == 3:
            character_ids.append("c3")

        shots.append(
            {
                "id": f"s{index}",
                "scene_id": f"scene-{(index + 1) // 2}",
                "index": index,
                "beat": beat,
                "prompt": f"{shot_prompt}. Story seed: {theme}. Style: {style_lock}",
                "characters": character_ids,
                "location": "rainy neon alley" if index != 2 else "office elevator lobby",
                "props": ["envelope", "phone"] if index in (1, 3, 5) else ["security badge"],
                "status": "ready",
                "consistency_score": 100,
                "output_url": None,
                "output_path": None,
                "aspect_ratio": "9:16",
                "visual_style": style_lock,
                "version": 1,
            }
        )

    series_bible = {
        "title": _title_from_prompt(theme),
        "mode": "short_drama",
        "style_lock": style_lock,
        "characters": characters,
    }
    storyboard = {"shots": shots}
    report = evaluate_storyboard_consistency(series_bible, storyboard)
    _apply_scores(storyboard, report)

    return {
        "series_bible": series_bible,
        "storyboard": storyboard,
        "consistency_report": report,
    }


def regenerate_mock_shot(storyboard: dict[str, Any], shot_id: str) -> dict[str, Any]:
    for shot in storyboard.get("shots", []):
        if shot.get("id") == shot_id:
            version = int(shot.get("version", 1)) + 1
            shot["version"] = version
            shot["status"] = "ready"
            shot["prompt"] = f"{shot.get('prompt', '').split(' Variant ')[0]} Variant {version}: tighter framing and clearer emotion."
            return shot
    raise KeyError(f"Shot '{shot_id}' not found")


def _apply_scores(storyboard: dict[str, Any], report: dict[str, Any]) -> None:
    penalties_by_shot: dict[str, int] = {}
    for issue in report.get("issues", []):
        shot_id = issue.get("shot_id")
        if shot_id:
            penalties_by_shot[shot_id] = penalties_by_shot.get(shot_id, 0) + 10
    for shot in storyboard.get("shots", []):
        shot["consistency_score"] = max(0, 100 - penalties_by_shot.get(shot.get("id"), 0))


def _title_from_prompt(prompt: str) -> str:
    cleaned = prompt.replace("\n", " ").strip()
    return cleaned[:32] if cleaned else "Short Drama"
