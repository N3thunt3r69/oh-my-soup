{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.oms;
  yaml = pkgs.formats.yaml { };
  configFile = yaml.generate "oms-config.yml" cfg.settings;
in
{
  options.programs.oms = {
    enable = lib.mkEnableOption "OMS coding agent";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "inputs.oms.packages.${pkgs.stdenv.hostPlatform.system}.default";
      description = "OMS package to install.";
    };

    settings = lib.mkOption {
      type = lib.types.nullOr yaml.type;
      default = null;
      description = ''
        Settings written declaratively to {file}`~/.oms/agent/config.yml`.
        On each `home-manager switch` the declared settings are copied into
        place as a writable regular file, so OMS can lock and rewrite it when
        persisting runtime changes (`/settings`, onboarding). Runtime changes
        are overwritten by the declared values on the next switch.
      '';
      example = {
        theme.dark = "titanium";
        startup.quiet = true;
      };
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];
    # OMS must be able to lock and atomically replace its runtime config, which
    # is impossible through a read-only /nix/store symlink.
    home.activation.omsConfig = lib.mkIf (cfg.settings != null) {
      before = [ ];
      after = [ "writeBoundary" ];
      data = ''
        run mkdir -p "$HOME/.oms/agent"
        run install -m 600 ${configFile} "$HOME/.oms/agent/config.yml"
      '';
    };
  };
}
