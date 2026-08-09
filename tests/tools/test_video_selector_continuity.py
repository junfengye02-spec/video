from __future__ import annotations

from types import SimpleNamespace

from tools.video.video_selector import VideoSelector


def _provider(*, supports: dict, operations: list[str] | None = None):
    return SimpleNamespace(
        supports=supports,
        input_schema={
            "properties": {
                "operation": {"enum": operations or []},
            }
        },
    )


def test_selector_exposes_first_last_contract_and_fields():
    assert "first_last_frame_to_video" in VideoSelector.capabilities
    properties = VideoSelector.input_schema["properties"]
    assert "first_frame_path" in properties
    assert "last_frame_path" in properties


def test_selector_filters_first_last_to_explicitly_capable_providers():
    selector = VideoSelector()
    capable = _provider(
        supports={"first_last_frame_to_video": True},
        operations=["first_last_frame_to_video"],
    )
    ordinary = _provider(supports={"reference_to_video": True}, operations=["reference_to_video"])

    assert selector._filter_candidates(
        {"operation": "first_last_frame_to_video"}, [capable, ordinary]
    ) == [capable]
    assert selector._filter_candidates(
        {"operation": "first_last_frame_to_video"}, [ordinary]
    ) == []

