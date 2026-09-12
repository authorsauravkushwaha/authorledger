from authorledger.analysis import analyze_text


def test_empty_text_does_not_crash():
    report = analyze_text("").to_dict()
    assert report["word_count"] == 0
    assert report["burstiness"] is None


def test_word_and_sentence_counts():
    text = "Hello world. This is a test. Short one."
    report = analyze_text(text).to_dict()
    assert report["word_count"] == 8
    assert report["sentence_count"] == 3


def test_uniform_sentences_have_low_burstiness():
    uniform = " ".join(["This is exactly five words."] * 6)
    report = analyze_text(uniform).to_dict()
    assert report["burstiness"] is not None
    assert report["burstiness"] < 0.1


def test_varied_sentences_have_higher_burstiness():
    varied = (
        "No. "
        "That single word sat there for a very long time before anyone answered it. "
        "Wait. "
        "Then, slowly, carefully, as if testing the ground beneath a very old and creaking staircase, someone did. "
        "Fine."
    )
    report = analyze_text(varied).to_dict()
    assert report["burstiness"] is not None
    uniform = " ".join(["This is exactly five words."] * 6)
    uniform_report = analyze_text(uniform).to_dict()
    assert report["burstiness"] > uniform_report["burstiness"]


def test_flagged_phrases_are_detected_and_counted():
    text = "We need to delve into this. Let's delve into it further, and delve into it once more."
    report = analyze_text(text).to_dict()
    phrases = {f["phrase"]: f["count"] for f in report["flagged_phrases"]}
    assert phrases.get("delve into") == 3


def test_no_flagged_phrases_in_plain_text():
    text = "The cat sat on the mat and looked at the door for a while."
    report = analyze_text(text).to_dict()
    assert report["flagged_phrases"] == []


def test_lexical_diversity_bounds():
    repetitive = "the the the the the the the the the the"
    report = analyze_text(repetitive).to_dict()
    assert 0.0 <= report["lexical_diversity"] <= 1.0
    assert report["lexical_diversity"] < 0.2  # only one unique word


def test_repeated_trigram_rate_detects_copy_paste_repetition():
    text = ("the quick brown fox jumps over the lazy dog. " * 4)
    report = analyze_text(text).to_dict()
    assert report["repeated_trigram_rate"] > 0.3


def test_em_dash_rate():
    text = "One thought—interrupted—by another—and another."
    report = analyze_text(text).to_dict()
    assert report["em_dash_per_1000_words"] > 0


def test_notes_are_never_empty():
    report = analyze_text("A short plain sentence with nothing unusual in it at all today.").to_dict()
    assert len(report["notes"]) >= 1
