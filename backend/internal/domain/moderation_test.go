package domain

import "testing"

func TestStaffObjectScopeAndIndependentAppeals(t *testing.T) {
	if CanModerate("tourist", "none", "author", "none", "reporter") {
		t.Fatal("ordinary user obtained moderation")
	}
	if CanModerate("moderator", "moderator", "moderator", "none", "reporter") {
		t.Fatal("self moderation permitted")
	}
	if CanModerate("moderator", "moderator", "author", "none", "moderator") {
		t.Fatal("reporter decided own case")
	}
	if CanModerate("moderator", "moderator", "staff", "admin", "reporter") {
		t.Fatal("moderator sanctioned privileged staff")
	}
	if !CanModerate("moderator", "moderator", "author", "none", "reporter") {
		t.Fatal("valid scoped case denied")
	}
	if CanResolveAppeal("moderator", "moderator", "author", "none", "moderator", "reporter") {
		t.Fatal("original moderator decided appeal")
	}
	if CanResolveAppeal("reporter", "moderator", "author", "none", "original", "reporter") {
		t.Fatal("original reporter decided appeal")
	}
	if !CanResolveAppeal("other", "moderator", "author", "none", "original", "reporter") {
		t.Fatal("independent reviewer denied")
	}
}
