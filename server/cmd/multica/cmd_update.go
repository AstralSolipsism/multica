package main

import (
	"fmt"
	"os"
	"time"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

var updateDownloadTimeout time.Duration = cli.DefaultUpdateDownloadTimeout

var (
	fetchUpdateVersion = cli.FetchLatestVersion
	downloadUpdate     = cli.UpdateViaDownloadWithTimeout
)

var updateCmd = &cobra.Command{
	Use:   "update",
	Short: "Update multica to the latest version",
	RunE:  runUpdate,
}

func init() {
	updateCmd.Flags().DurationVar(&updateDownloadTimeout, "download-timeout", cli.DefaultUpdateDownloadTimeout, "Maximum time to wait for the release archive download")
}

func runUpdate(_ *cobra.Command, _ []string) error {
	if updateDownloadTimeout <= 0 {
		return fmt.Errorf("download timeout must be greater than zero")
	}
	if !cli.IsReleaseVersion(version) {
		return fmt.Errorf("refusing to replace a development or unrecognized build (%s); install a release explicitly to switch", version)
	}

	fmt.Fprintf(os.Stderr, "Current version: %s (commit: %s, built: %s)\n", version, commit, date)

	// Check the latest version on the internal release source. There is no
	// upstream fallback: this build carries internal customizations, and an
	// update from the upstream GitHub Releases would overwrite them.
	latest, err := fetchUpdateVersion()
	if err != nil {
		return fmt.Errorf("could not check the latest version on the internal release source (%s): %w", cli.DefaultDownloadBase, err)
	}
	if !cli.IsNewerVersion(latest, version) {
		fmt.Fprintln(os.Stderr, "Already up to date.")
		return nil
	}
	fmt.Fprintf(os.Stderr, "Latest version:  %s\n\n", latest)

	fmt.Fprintf(os.Stderr, "Downloading %s from the internal release source...\n", latest)
	output, err := downloadUpdate(latest, updateDownloadTimeout)
	if err != nil {
		return fmt.Errorf("update failed: %w", err)
	}
	fmt.Fprintf(os.Stderr, "%s\nUpdate complete.\n", output)
	return nil
}
