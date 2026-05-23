import { ConnectionList } from "@/components/project-picker/ConnectionList";
import { ProjectList } from "@/components/project-picker/ProjectList";
import { IntegrationsTab } from "@/components/project-picker/IntegrationsTab";
import { ThemeToggle } from "@/components/common/ThemeToggle";
import { useConnectionContext } from "@/contexts/ConnectionContext";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/ui/tabs";

export function ProjectPicker() {
  const { view } = useConnectionContext();

  return (
    <div className="flex items-center justify-center min-h-screen bg-background text-foreground p-8 relative">
      {/* Theme Toggle - Top Right */}
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>

      <div className="max-w-3xl w-full">
        <div className="text-center mb-8">
          <img src="/maestro-logo.png" alt="Maestro logo" className="w-20 h-20 mx-auto mb-4" />
          <h1 className="text-3xl font-semibold mb-3">Maestro</h1>
          <h3 className="text-base text-muted-foreground">An agent orchestrator tool.</h3>
        </div>

        {/* Single Panel with Slide Transition */}
        <div className="bg-card border border-border rounded-lg overflow-clip relative min-h-125 max-h-175">
          {/* Connections View */}
          <div
            className={`absolute inset-0 p-6 transition-transform duration-300 ease-in-out flex flex-col ${
              view === "projects" ? "-translate-x-full invisible" : "translate-x-0"
            }`}
          >
            <Tabs defaultValue="connections" className="flex flex-col h-full">
              <TabsList className="w-full mb-4">
                <TabsTrigger value="connections">Connections</TabsTrigger>
                <TabsTrigger value="integrations">Integrations</TabsTrigger>
              </TabsList>
              <TabsContent value="connections" className="flex-1 overflow-hidden">
                <ConnectionList />
              </TabsContent>
              <TabsContent value="integrations" className="flex-1 overflow-hidden">
                <IntegrationsTab />
              </TabsContent>
            </Tabs>
          </div>

          {/* Projects View */}
          <div
            className={`absolute inset-0 p-6 transition-transform duration-300 ease-in-out flex flex-col ${
              view === "projects" ? "translate-x-0" : "translate-x-full"
            }`}
          >
            <ProjectList />
          </div>
        </div>
      </div>
    </div>
  );
}
