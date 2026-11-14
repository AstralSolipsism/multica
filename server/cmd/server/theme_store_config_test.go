package main

import "testing"

func TestThemeStoreRequiresExplicitOptIn(t *testing.T) {
	for _, value := range []string{"", "off", "false", "0", "disabled", "typo", "on", "true", "1", " TRUE "} {
		t.Run(value, func(t *testing.T) {
			t.Setenv("MULTICA_THEME_STORE", value)
			t.Setenv("MULTICA_THEME_REGISTRY_URL", "https://example.test/index.json")
			want := value == "on" || value == "true" || value == "1" || value == " TRUE "
			if got := themeStoreFromEnv() != nil; got != want {
				t.Fatalf("store enabled = %v, want %v", got, want)
			}
		})
	}
}
