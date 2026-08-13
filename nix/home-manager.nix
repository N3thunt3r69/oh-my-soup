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
        The file is a read-only store symlink: changes made from inside OMS
        (`/settings`, onboarding) replace it but revert on the next
        `home-manager switch`.
      '';
      example = {
        theme.dark = "titanium";
        startup.quiet = true;
      };
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];
    home.file.".oms/agent/config.yml" = lib.mkIf (cfg.settings != null) {
      source = yaml.generate "oms-config.yml" cfg.settings;
    };
  };
}
