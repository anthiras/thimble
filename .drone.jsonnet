local docker = (import 'docker.libsonnet');
local util = (import 'util.libsonnet');

# Configuration
local projectName = "mir-webviz";
local majorVersion = '1';
local minorVersion = '1';
local patchVersion = '$DRONE_BUILD_NUMBER';
local branchTags = [
  majorVersion + '.' + minorVersion + '-branch'
];
local masterTags = [
  majorVersion,
  majorVersion + '.' + minorVersion,
  majorVersion + '.' + minorVersion + '.' + patchVersion,
  'latest'
];

[
  util.whenNotBranch("master")
  + docker.standardPipeline(
    name = "Build " + projectName,
    projectName = projectName,
    tags = branchTags,
    testSteps= [{
      "name": "Test",
      "image": "docker.artifactory.devops/mir-webviz:" + majorVersion + '.' + minorVersion + '-branch',
      "pull": "never",
      "commands": [
      'echo "Your test commands here"',
      ],
      #"environment": {
      #  "GIT_SSH_PRIVATE_KEY": {
      #    "from_secret": "GIT_SSH_PRIVATE_KEY"
      #  },
      #  "GITEA_ACCESS_TOKEN": {
      #    "from_secret": "GITEA_ACCESS_TOKEN"
      #  },
      #  "ARTIFACTORY_API_KEY": {
      #    "from_secret": "ARTIFACTORY_API_KEY"
      #  }
      #}
    },]
  )
  + { node: { role: "devops" } },

  util.whenBranch("master")
  + docker.standardPipeline(
    name = "Build " + projectName +" - master",
    projectName = projectName,
    tags = masterTags,
    testSteps= [{
      "name": "Test",
      "image": "docker.artifactory.devops/mir-webviz:" + majorVersion,
      "pull": "never",
      "commands": [
      'echo "Your test commands here"',
      ],
      #"environment": {
      #  "GIT_SSH_PRIVATE_KEY": {
      #    "from_secret": "GIT_SSH_PRIVATE_KEY"
      #  },
      #  "GITEA_ACCESS_TOKEN": {
      #    "from_secret": "GITEA_ACCESS_TOKEN"
      #  },
      #  "ARTIFACTORY_API_KEY": {
      #    "from_secret": "ARTIFACTORY_API_KEY"
      #  }
      #}
    },]
  )
  + { node: { role: "devops" } },


  // Automated updating of the serthe service
  util.whenBranch("master")
  + docker.script(
    name = "Update " + projectName,
    image = "docker",
    dind = true,
    commands = [
      'docker service update --image docker.artifactory.devops/'+projectName + ':' +
        majorVersion + '.' + minorVersion + '.' + patchVersion + ' mir-webviz_webviz'
    ]
  )
  + { "depends_on": [ "Build " + projectName +" - master" ] }
  + { node: { role: "swarm-deploy" } }

]
