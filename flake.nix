{
  description = "kimi-cli flake";
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixpkgs-unstable";
    systems.url = "github:nix-systems/default";
    pyproject-nix = {
      url = "github:pyproject-nix/pyproject.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    uv2nix = {
      url = "github:pyproject-nix/uv2nix";
      inputs.pyproject-nix.follows = "pyproject-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    pyproject-build-systems = {
      url = "github:pyproject-nix/build-system-pkgs";
      inputs.pyproject-nix.follows = "pyproject-nix";
      inputs.uv2nix.follows = "uv2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };
  outputs =
    {
      self,
      nixpkgs,
      systems,
      pyproject-nix,
      uv2nix,
      pyproject-build-systems,
    }:
    let
      allSystems = import systems;
      forAllSystems =
        f:
        nixpkgs.lib.genAttrs allSystems (
          system:
          let
            pkgs = import nixpkgs {
              inherit system;
              config.allowUnfree = true;
            };
          in
          f { inherit system pkgs; }
        );
    in
    {
      packages = forAllSystems (
        { pkgs, ... }:
        let
          inherit (pkgs)
            lib
            python313
            callPackage
            ;
          python = python313;
          pyproject = lib.importTOML ./pyproject.toml;
          workspace = uv2nix.lib.workspace.loadWorkspace { workspaceRoot = ./.; };

          overlay = workspace.mkPyprojectOverlay {
            sourcePreference = "wheel";
          };
          extraBuildOverlay = final: prev: {
            # Add setuptools build dependency for ripgrepy
            ripgrepy = prev.ripgrepy.overrideAttrs (old: {
              nativeBuildInputs = (old.nativeBuildInputs or [ ]) ++ [ final.setuptools ];
            });
            # Replace README symlink with real file for Nix builds.
            "kimi-code" = prev."kimi-code".overrideAttrs (old: {
              postPatch = (old.postPatch or "") + ''
                rm -f README.md
                cp ${./README.md} README.md
              '';
            });
          };
          pythonSet = (callPackage pyproject-nix.build.packages { inherit python; }).overrideScope (
            lib.composeManyExtensions [
              pyproject-build-systems.overlays.wheel
              overlay
              extraBuildOverlay
            ]
          );

          kimi-cli =
            let
              inherit (pkgs)
                lib
                ripgrep
                stdenvNoCC
                makeWrapper
                versionCheckHook
                ;
              kimiCliPackage = pythonSet.mkVirtualEnv "kimi-cli-virtual-env-${pyproject.project.version}" workspace.deps.default;
            in
            stdenvNoCC.mkDerivation ({
              pname = "kimi-cli";
              version = pyproject.project.version;

              dontUnpack = true;

              nativeBuildInputs = [ makeWrapper ];
              buildInputs = [ ripgrep ];

              installPhase = ''
                runHook preInstall

                mkdir -p $out/bin
                makeWrapper ${kimiCliPackage}/bin/kimi $out/bin/kimi \
                  --prefix PATH : ${lib.makeBinPath [ ripgrep ]} \
                  --set KIMI_CLI_NO_AUTO_UPDATE "1"

                runHook postInstall
              '';

              nativeInstallCheckInputs = [
                versionCheckHook
              ];
              versionCheckProgramArg = "--version";
              doInstallCheck = true;

              meta = {
                description = "Kimi Code CLI is a new CLI agent that can help you with your software development tasks and terminal operations";
                license = lib.licenses.asl20;
                sourceProvenance = with lib.sourceTypes; [ fromSource ];
                maintainers = with lib.maintainers; [
                  xiaoxiangmoe
                ];
                mainProgram = "kimi";
              };
            });

          devEnv =
            let
              editableOverlay = workspace.mkEditablePyprojectOverlay {
                root = "$REPO_ROOT";
              };
              editablePythonSet = pythonSet.overrideScope editableOverlay;
            in
            {
              devVirtualEnv = editablePythonSet.mkVirtualEnv "kimi-cli-dev-virtual-env-${pyproject.project.version}" workspace.deps.all;
              devPythonInterpreter = editablePythonSet.python.interpreter;
            };
        in
        {
          inherit kimi-cli;
          inherit (devEnv) devVirtualEnv devPythonInterpreter;
          default = kimi-cli;
        }
      );
      formatter = forAllSystems ({ pkgs, ... }: pkgs.nixfmt-tree);
      devShells = forAllSystems (
        { pkgs, system, ... }:
        let
          venv = self.packages.${system}.devVirtualEnv;
          python = self.packages.${system}.devPythonInterpreter;
        in
        {
          default = pkgs.mkShell {
            packages = [
              venv
            ]
            ++ (with pkgs; [
              uv
              prek
              nodejs
              biome
            ]);

            env = {
              UV_NO_SYNC = "1";
              UV_PYTHON = python;
              UV_PROJECT_ENVIRONMENT = venv;
              UV_PYTHON_DOWNLOADS = "never";
            };

            shellHook = ''
              unset PYTHONPATH
              export REPO_ROOT=$(git rev-parse --show-toplevel)
            '';
          };
        }
      );
    };
}
