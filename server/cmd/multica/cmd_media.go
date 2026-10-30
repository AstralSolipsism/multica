package main

import (
	"fmt"
	"os"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/multica-ai/multica/server/internal/daemon/media"
	"github.com/spf13/cobra"
)

var mediaCmd = &cobra.Command{Use: "media", Short: "Manage native media executors"}
var mediaLoginCmd = &cobra.Command{
	Use: "login", Short: "Sign in to an isolated native media profile", Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		provider, _ := cmd.Flags().GetString("provider")
		profile, _ := cmd.Flags().GetString("profile")
		if provider != "codex" {
			return fmt.Errorf("%s: %w; host-native login mapping is required", provider, media.ErrContractUnverified)
		}
		if os.Getenv(cli.TaskConfigRootEnv) != "" {
			return fmt.Errorf("media login must run on the daemon host, outside an agent task")
		}
		root, err := cli.ProfileDir("")
		if err != nil {
			return err
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		p, err := media.OpenProfile(root, home, profile, provider, true)
		if err != nil {
			return err
		}
		deviceAuth, _ := cmd.Flags().GetBool("device-auth")
		return media.Login(cmd.Context(), p, "codex", deviceAuth, cmd.InOrStdin(), cmd.OutOrStdout(), cmd.ErrOrStderr())
	},
}

func init() {
	mediaCmd.GroupID = groupRuntime
	mediaLoginCmd.Flags().String("provider", "", "Native provider (codex, agy, flow, whisk)")
	mediaLoginCmd.Flags().Bool("device-auth", false, "Use native device authentication")
	_ = mediaLoginCmd.MarkFlagRequired("provider")
	mediaCmd.AddCommand(mediaLoginCmd)
	rootCmd.AddCommand(mediaCmd)
}
