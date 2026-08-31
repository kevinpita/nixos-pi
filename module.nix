{
  self,
  pi-flake,
}:
{
  pkgs,
  username,
  ...
}:
let
  system = pkgs.stdenv.hostPlatform.system;
  piPackage = self.packages.${system}.pi-coding-agent;
  piAudit = pkgs.writeShellApplication {
    name = "pi-audit";
    text = ''
      exec ${piPackage}/bin/pi -e npm:@vigolium/piolium "$@"
    '';
  };
  piSessionMaintenance = pkgs.writeShellApplication {
    name = "pi-session-maintenance";
    runtimeInputs = with pkgs; [
      coreutils
      findutils
      gnutar
      zstd
    ];
    text = builtins.readFile ./scripts/pi-session-maintenance.sh;
  };
in
{
  imports = [ pi-flake.nixosModules.default ];

  programs.nix-ld.enable = true;

  services.pi-coding-agent = {
    enable = true;
    users = [ username ];
    package = piPackage;
    extraEnv = {
      PI_SKIP_VERSION_CHECK = "1";
      PI_TELEMETRY = "0";
    };
    extensions = [ ];
    agentFiles.keybindings = {
      mutable = false;
      value = {
        "tui.editor.cursorRight" = [ "right" ];
        "app.session.rename" = [ ];
      };
    };
  };

  environment = {
    systemPackages = with pkgs; [
      fd
      nodejs
      piAudit
      piSessionMaintenance
    ];

    sessionVariables = {
      PI_SKIP_VERSION_CHECK = "1";
      PI_TELEMETRY = "0";
    };
  };

  home-manager.users.${username} =
    { config, ... }:
    {
      home.file = {
        ".pi/agent/skills".source = ./skills;

        ".pi/agent/AGENTS.md".source = ./AGENTS.md;

        ".pi/agent/pstack.json" = {
          force = true;
          text = builtins.toJSON {
            defaultOn = true;
            models = {
              analysis = "openai-codex/gpt-5.6-sol:xhigh";
              implementation = "openai-codex/gpt-5.6-sol:xhigh";
              review = [ "openai-codex/gpt-5.6-sol:xhigh" ];
            };
          };
        };

        ".config/rpiv-todo/config.json" = {
          force = true;
          text = builtins.toJSON { maxWidgetLines = 5; };
        };

        ".pi/settings.json" = {
          force = true;
          text = builtins.toJSON { ayu.checkpoint.enabled = false; };
        };

        ".pi/agent/extensions/auto-compact.ts".source = ./extensions/auto-compact.ts;
        ".pi/agent/extensions/auto-session-name.ts".source = ./extensions/auto-session-name.ts;
        ".pi/agent/extensions/copy-code/index.ts".source = ./extensions/copy-code/index.ts;
        ".pi/agent/extensions/copy-code/parser.ts".source = ./extensions/copy-code/parser.ts;
        ".pi/agent/extensions/file-picker.ts".source = ./extensions/file-picker.ts;
        ".pi/agent/extensions/git-reference-picker".source = ./extensions/git-reference-picker;
        ".pi/agent/extensions/global-prompt-history".source = ./extensions/global-prompt-history;
        ".pi/agent/extensions/session-status".source = ./extensions/session-status;
        ".pi/agent/extensions/split-session".source = ./extensions/split-session;

        ".pi/agent/extensions/subagent/config.json" = {
          force = true;
          text = builtins.toJSON {
            defaultSessionDir = "${config.home.homeDirectory}/.local/state/pi-subagents/sessions";
            artifactDir = "temp";
          };
        };

        ".pi/agent/global-prompt-history.json" = {
          force = true;
          text = builtins.toJSON {
            excludedCwdPrefixes = [
              "${config.home.homeDirectory}/.pi/agent/npm/node_modules/pi-intercom"
            ];
          };
        };

        ".pi/agent/settings.json" = {
          force = true;
          text = builtins.toJSON {
            lastChangelogVersion = piPackage.version;
            defaultProvider = "openai-codex";
            defaultModel = "gpt-5.6-sol";
            defaultThinkingLevel = "xhigh";
            # Pi compacts when contextTokens > contextWindow - reserveTokens.
            # 27200 = 10% of the 272k gpt-5.6-sol window, so Pi's own check
            # (after a run, or before a prompt) fires at 90%. The auto-compact
            # extension covers the same 90% line in the middle of a run.
            compaction = {
              enabled = true;
              reserveTokens = 27200;
              keepRecentTokens = 20000;
            };
            enableInstallTelemetry = false;
            enableSkillCommands = true;
            theme = "dark";
            tuiMode = "regular";
            packages = [
              "npm:@juicesharp/rpiv-ask-user-question"
              "npm:@juicesharp/rpiv-todo"
              "npm:pi-cd"
              "npm:pi-intercom"
              {
                source = "npm:@ogulcancelik/pi-herdr";
                skills = [ ];
              }
              "npm:pi-web-access"
              "npm:pi-subagents"
              {
                source = "npm:@kevinpita/pi-pstack";
                skills = [ "+skills/pstack-mode/SKILL.md" ];
              }
              "npm:@ff-labs/fff-bun"
              "npm:@ff-labs/pi-fff"
              "npm:@narumitw/pi-usage"
              "npm:pi-zentui"
              "npm:pi-simplify"
              "npm:pi-claude-code-tui"
              "npm:pi-colours"
              "npm:@quintinshaw/pi-dynamic-workflows"
              "${./extensions/profile-modes}"
            ];
          };
        };

        ".pi/agent/prompts".source = ./prompts;
        ".pi/agent/themes".source = ./themes;

        ".pi/agent/zentui.json" = {
          force = true;
          text = builtins.toJSON {
            extensionStatuses.colorModes = {
              dictation = "original";
            };
          };
        };

        ".claude/skills" = {
          force = true;
          source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/.pi/agent/skills";
        };

        ".codex/skills" = {
          force = true;
          source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/.pi/agent/skills";
        };
      };

      systemd.user = {
        services.pi-session-maintenance = {
          Unit.Description = "Archive and remove expired Pi sessions";
          Service = {
            Type = "oneshot";
            ExecStart = "${piSessionMaintenance}/bin/pi-session-maintenance";
          };
        };
        timers.pi-session-maintenance = {
          Unit.Description = "Run Pi session maintenance each week";
          Timer = {
            OnCalendar = "weekly";
            Persistent = true;
            RandomizedDelaySec = "1h";
          };
          Install.WantedBy = [ "timers.target" ];
        };
      };
    };
}
