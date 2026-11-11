package server

import (
	"encoding/json"
	"testing"
)

func TestUpdatesTellAMissingFieldFromAClearedOne(t *testing.T) {
	type Patch struct {
		Contact doubleOption[string] `json:"contact"`
	}
	parse := func(body string) doubleOption[string] {
		var patch Patch
		if err := json.Unmarshal([]byte(body), &patch); err != nil {
			t.Fatalf("%s: %v", body, err)
		}
		return patch.Contact
	}
	if got := parse(`{}`); got.Set || got.Value != nil {
		t.Errorf("missing field: %+v", got)
	}
	if got := parse(`{"contact":null}`); !got.Set || got.Value != nil {
		t.Errorf("cleared field: %+v", got)
	}
	if got := parse(`{"contact":"wx: a"}`); !got.Set || got.Value == nil || *got.Value != "wx: a" {
		t.Errorf("set field: %+v", got)
	}
}

func TestTextIsTrimmedBlankIsNoneAndLengthCountsCharacters(t *testing.T) {
	if got, err := cleanText(ptr("  a b  "), 3, "x"); err != nil || got == nil || *got != "a b" {
		t.Errorf("trimmed: %v %v", got, err)
	}
	if got, err := cleanText(ptr("   "), 3, "x"); err != nil || got != nil {
		t.Errorf("blank: %v %v", got, err)
	}
	if got, err := cleanText(ptr("张三丰"), 3, "x"); err != nil || got == nil || *got != "张三丰" {
		t.Errorf("three characters: %v %v", got, err)
	}
	if _, err := cleanText(ptr("张三丰丰"), 3, "x"); err == nil {
		t.Error("four characters must be too long")
	}
	if _, err := cleanName(ptr(" ")); err == nil {
		t.Error("a blank name must be refused")
	}
}
