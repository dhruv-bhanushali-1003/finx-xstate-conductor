// src/App.js
import React from "react";
import { useState, useEffect } from "react";
import axios from "axios";
import { setup, assign, fromPromise } from "xstate";
import { useMachine } from "@xstate/react";
import { useForm } from "react-hook-form";
import { Form } from "react-formio";
import "formiojs/dist/formio.full.css";
import { Formio } from "formiojs";

Formio.setBaseUrl("http://3.110.81.211");

// -------------------- Conductor Service --------------------
const ConductorService = {
  async startWorkflow(workflowName = "Finx Bank loan-application-process") {
    try {
      const res = await axios.post(
        `https://base-api.fincuro.in/gateway/ui-workflow/api/workflow`,
        { name: workflowName }
      );
      return { workflowId: res.data };
    } catch (err) {
      console.error("startWorkflow error:", err);
      throw err;
    }
  },

  async getApplicationByUUID(uuid) {
    try {
      console.log(uuid);
      const res = await axios.get(
        `https://base-api.fincuro.in/gateway/ui-workflow/api/application-data/${uuid}`
      );
      console.log(res.data);
      return res.data;
    } catch (err) {
      console.error("getApplicationByUUID error:", err);
      throw err;
    }
  },

  async getWorkflowStatus(workflowId) {
    try {
      const res = await axios.get(
        `https://base-api.fincuro.in/gateway/ui-workflow/api/workflow/${workflowId}`
      );
      return res.data;
    } catch (err) {
      console.error("getWorkflowStatus error:", err);
      throw err;
    }
  },

  async pollForTask(taskType, workerId = "loan-ui-worker") {
    try {
      console.log("Polling for task:", taskType);
      const res = await axios.get(
        `https://base-api.fincuro.in/gateway/ui-workflow/api/tasks/poll/${taskType}`,
        { params: { workerid: workerId } }
      );
      if (!res.data || !res.data.taskType) return null;
      return res.data;
    } catch (err) {
      console.error("pollForTask error:", err);
      throw err;
    }
  },

  async completeTask(workflowInstanceId, taskId, outputData) {
    try {
      console.log("Completing task:", taskId, "with data:", outputData);
      const res = await axios.post(
        `https://base-api.fincuro.in/gateway/ui-workflow/api/tasks`,
        {
          taskId,
          workflowInstanceId,
          status: "COMPLETED",
          outputData,
        }
      );
      return res.data;
    } catch (err) {
      console.error("completeTask error:", err);
      throw err;
    }
  },
};

// -------------------- XState Machine Definition --------------------
export const loanMachine = setup({
  actors: {
    startWorkflow: fromPromise(() => ConductorService.startWorkflow()),

    pollNextUiTask: fromPromise(async ({ input }) => {
      const workflow = await ConductorService.getWorkflowStatus(
        input.workflowId
      );
      if (workflow.status !== "RUNNING") {
        return { status: workflow.status, task: null };
      }
      const nextUiTask = workflow.tasks.find(
        (t) =>
          t.status === "SCHEDULED" &&
          t.inputData?.ui_component !== "BankReviewInfoScreen" &&
          t.inputData?.ui_component !== "BankApprovalScreen"
      );
      if (!nextUiTask) {
        console.warn("No UI task found in workflow:", input.workflowId);
        return { status: workflow.status, task: null };
      }
      const polled = await ConductorService.pollForTask(nextUiTask.taskDefName);
      if (!polled?.inputData?.form_id) {
        console.warn("Polled task is not UI:", polled?.taskDefName);
        return { status: workflow.status, task: null };
      }
      console.log("Current UI task:", polled?.inputData?.ui_component);
      return polled;
    }),

    validate: fromPromise(({ input }) => {
      const data = input.formData || {};
      const missing = Object.entries(data).filter(
        ([_, v]) => v === null || v === undefined || v === ""
      );
      if (missing.length) throw new Error("Please fill all fields.");
      return true;
    }),

    submitTask: fromPromise(({ input }) => {
      if (!input.currentTask) throw new Error("No task to submit");
      return ConductorService.completeTask(
        input.workflowId,
        input.currentTask.taskId,
        {
          formData: input.formData,
        }
      );
    }),
  },
}).createMachine({
  id: "loanApp",
  initial: "idle",
  context: {
    workflowId: null,
    currentTask: null,
    formData: {},
    error: null,
  },
  states: {
    idle: {
      on: {
        FORM_UPDATE: {
          actions: assign({
            workflowId: ({ context, event }) =>
              (event.data || event).workflowId || context.workflowId,
            formData: ({ context, event }) => ({
              ...context.formData,
              ...(event.data || event),
            }),
          }),
        },
        START: [
          {
            guard: ({ context }) => {
              console.log(
                "Guard check - context.workflowId:",
                context.workflowId
              );
              console.log(
                "Guard check - context.formData.workflowId:",
                context.formData?.workflowId
              );
              return context.workflowId;
            },
            target: "polling",
          },
          {
            target: "starting",
          },
        ],
      },
    },

    starting: {
      invoke: {
        src: "startWorkflow",
        onDone: {
          target: "polling",
          actions: assign({
            workflowId: ({ event }) => event.output.workflowId,
            formData: ({ context, event }) => ({
              ...context.formData,
              workflowId: event.output.workflowId,
            }),
          }),
        },
        onError: {
          target: "error",
          actions: assign({
            error: ({ event }) => event.error,
          }),
        },
      },
    },

    polling: {
      invoke: {
        src: "pollNextUiTask",
        input: ({ context }) => ({ workflowId: context.workflowId }),
        onDone: [
          {
            guard: ({ event }) => {
              console.log("Polled event:", event);
              return event.output.task !== null;
            },
            target: "rendering",
            actions: assign({
              currentTask: ({ event }) => event.output,
            }),
          },
          {
            guard: ({ event }) => event.output.status === "COMPLETED",
            target: "completed",
          },
          {
            guard: ({ event }) =>
              ["FAILED", "TERMINATED", "TIMED_OUT"].includes(
                event.output.status
              ),
            target: "error",
            actions: assign({
              error: ({ event }) =>
                `Workflow ended with status: ${event.output.status}`,
            }),
          },
          {
            target: "waitForPoll", // fallback if workflow is still running but no task yet
          },
        ],
        onError: {
          target: "error",
          actions: assign({
            error: ({ event }) => event.error,
          }),
        },
      },
    },

    waitForPoll: {
      after: {
        3000: "polling",
      },
    },

    rendering: {
      on: {
        FORM_UPDATE: {
          actions: assign({
            workflowId: ({ context, event }) =>
              (event.data || event).workflowId || context.workflowId,
            formData: ({ context, event }) => ({
              ...context.formData,
              ...(event.data || event),
            }),
          }),
        },
        FORM_SUBMIT: "validating",
      },
    },

    validating: {
      invoke: {
        src: "validate",
        input: ({ context }) => context,
        onDone: "submitting",
        onError: {
          target: "rendering",
          actions: assign({
            error: ({ event }) => event.error,
          }),
        },
      },
    },

    submitting: {
      invoke: {
        src: "submitTask",
        input: ({ context }) => context,
        onDone: "polling",
        onError: {
          target: "error",
          actions: assign({
            error: ({ event }) => event.error,
          }),
        },
      },
    },

    completed: {
      type: "final",
    },

    error: {
      on: {
        RETRY: "polling",
      },
    },
  },
});

async function loginAndGetToken() {
  const response = await fetch(`${process.env.REACT_APP_FORMIO_API_BASE_URL}/user/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      data: {
        email: process.env.REACT_APP_FORMIO_LOGIN_EMAIL,
        password: process.env.REACT_APP_FORMIO_LOGIN_PASSWORD,
      },
    }),
  });

  const token = response.headers.get("x-jwt-token");
  Formio.setToken(token);
}

// -------------------- Forms --------------------

function FormRenderer({ onUpdate, onSubmit, formId }) {
  return (
    <div className="bg-white rounded-lg shadow-lg p-6 form-container">
      <Form
        src={`${process.env.REACT_APP_FORMIO_API_BASE_URL}/form/${formId}`}
        options={{ readOnly: false, noAlerts: true, template: "bootstrap3" }}
        onSubmit={(submission) => {
          onUpdate(submission.data);
          onSubmit(submission.data);
        }}
      />
    </div>
  );
}

// -------------------- Panel Components --------------------
function TopPanel() {
  return (
    <div className="text-white px-6 py-4 flex items-center justify-between w-full relative z-10" style={{ backgroundColor: '#33297A' }}>
      <div className="flex items-center">
        <img 
          src="/finxlogo.png" 
          alt="FinX Logo" 
          className="h-12 w-auto mr-4"
          onError={(e) => {
            console.log('Image failed to load:', e.target.src);
            e.target.style.display = 'none';
          }}
        />
      </div>
      <div className="flex items-center space-x-4">    
        <div className="flex items-center space-x-4">
          {/* Search Icon */}
          <div className="w-10 h-10 flex items-center justify-center cursor-pointer">
            <img 
              src="/search.png" 
              alt="Search" 
              className="w-6 h-6 brightness-150"
              onError={(e) => {
                e.target.style.display = 'none';
              }}
            />
          </div>
          {/* Notification Icon */}
          <div className="w-10 h-10 flex items-center justify-center cursor-pointer">
            <img 
              src="/notification.png" 
              alt="Notifications" 
              className="w-6 h-6 brightness-150"
              onError={(e) => {
                e.target.style.display = 'none';
              }}
            />
          </div>
          {/* Profile Icon */}
          <div className="w-10 h-10 flex items-center justify-center cursor-pointer">
            <img 
              src="/Profile.png" 
              alt="Profile" 
              className="w-8 h-8 rounded-full brightness-150"
              onError={(e) => {
                e.target.style.display = 'none';
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function LeftPanel({ activeItem, onItemClick, disabled = false }) {
  const menuItems = [
    { 
      id: 'home', 
      label: 'Home', 
      icon: '/Home.png',
      activeIcon: '/homewhite.png'
    },
    { 
      id: 'personal', 
      label: 'Personal Information', 
      icon: '/Personal.png',
      activeIcon: '/Personalwhite.png'
    },
    { 
      id: 'finance', 
      label: 'Finance Information', 
      icon: '/Finacial.png',
      activeIcon: '/FinancialWite.png'
    },
    { 
      id: 'employment', 
      label: 'Employment Information', 
      icon: '/Employment.png',
      activeIcon: '/EmploymentWhite.png'
    }
  ];

  return (
    <div className="w-72 rounded-lg shadow-lg mx-4 my-8 min-h-screen" style={{ backgroundColor: '#F9FAFB' }}>
      <div className="p-6">
        <nav className="space-y-1">
          {menuItems.map((item) => (
            <button
              key={item.id}
              onClick={() => onItemClick && onItemClick(item.id)}
              disabled={disabled}
              className={`w-full flex items-center px-4 py-3 text-left rounded-lg transition-colors ${
                activeItem === item.id
                  ? 'text-white'
                  : disabled
                  ? 'text-gray-400 cursor-not-allowed'
                  : 'text-gray-600 hover:bg-gray-100'
              }`}
              style={activeItem === item.id ? { backgroundColor: '#33297A' } : {}}
            >
              <img 
                src={activeItem === item.id ? item.activeIcon : item.icon} 
                alt={item.label} 
                className="w-5 h-5 mr-3"
                onError={(e) => {
                  console.log('Icon failed to load:', e.target.src);
                  e.target.style.display = 'none';
                }}
              />
              <span className="font-medium">{item.label}</span>
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
}

// -------------------- Main App --------------------
function LoanApplication() {
  const [state, send] = useMachine(loanMachine);
  const { currentTask, formData, error } = state.context;
  const [token, setToken] = useState(null);
  const [activeMenuItem, setActiveMenuItem] = useState('personal');
  const [navigationEnabled, setNavigationEnabled] = useState(false);

  // Map Form.io components to menu items
  const getMenuItemFromForm = (uiComponent, formId) => {
    const componentMap = {
      'PersonalInfoForm': 'personal',
      'FinancialInfoForm': 'finance', 
      'EmploymentInfoForm': 'employment',
    };
    
    // If we have a UI component, use that
    if (uiComponent && componentMap[uiComponent]) {
      return componentMap[uiComponent];
    }
    
    // Fallback: try to determine from form ID patterns
    if (formId) {
      const formIdLower = formId.toLowerCase();
      if (formIdLower.includes('personal') || formIdLower.includes('personalinfo')) {
        return 'personal';
      } else if (formIdLower.includes('financial') || formIdLower.includes('finance')) {
        return 'finance';
      } else if (formIdLower.includes('employment') || formIdLower.includes('employ')) {
        return 'employment';
      }
    }
    
    return 'personal'; // default fallback
  };

  // Handle tab navigation
  const handleTabNavigation = (menuItemId) => {
    if (!navigationEnabled) {
      console.log('Navigation disabled during workflow');
      return;
    }   
    // Only allow navigation if we're in a stable state
    if (!state.matches("rendering") && !state.matches("idle")) {
      console.log('Cannot navigate during workflow processing');
      return;
    }
  };

  useEffect(() => {
    loginAndGetToken().then(setToken);
    const urlParams = new URLSearchParams(window.location.search);
    const uuid = urlParams.get("uuid");

    if (uuid) {
      console.log("Loading existing application with UUID:", uuid);
      loadExistingApplication(uuid);
    } else {
      send({ type: "START" });
    }
  }, [send]);

  // Update active menu item when current task changes
  useEffect(() => {
    console.log(currentTask,formData,"currentTask")
    if (currentTask?.inputData) {
      const menuItem = getMenuItemFromForm(
        currentTask.inputData.ui_component, 
        currentTask.inputData.form_id
      );
      setActiveMenuItem(menuItem);
      console.log('Updated active menu item to:', menuItem, 'for component:', currentTask.inputData.ui_component, 'formId:', currentTask.inputData.form_id);
    }
  }, [currentTask]);

  // Enable/disable navigation based on workflow state
  useEffect(() => {
    // Enable navigation only when rendering forms (not during loading, validation, etc.)
    const isNavigationEnabled = state.matches("rendering") || state.matches("idle");
    setNavigationEnabled(isNavigationEnabled);
    console.log('Navigation enabled:', isNavigationEnabled, 'State:', state.value);
  }, [state]);

  const loadExistingApplication = async (uuid) => {
    try {
      const applicationData = await ConductorService.getApplicationByUUID(uuid);
      console.log("Loaded application data:", applicationData);

      // First update the context with existing data
      send({
        type: "FORM_UPDATE",
        data: applicationData.formData,
      });

      // Small delay to ensure context is updated before START
      setTimeout(() => {
        console.log(
          "Starting with existing workflowId:",
          applicationData.formData.workflowId
        );
        send({ type: "START" });
      }, 1000);
    } catch (error) {
      console.error("Failed to load application:", error);
      send({ type: "START" });
    }
  };

  const handleUpdate = (data) => send({ type: "FORM_UPDATE", data });
  const handleSubmit = (data) => {
    console.log("termsAccepted", data);
    send({ type: "FORM_UPDATE", data });
    send({ type: "FORM_SUBMIT" });
  };

  return (
    <div className="min-h-screen bg-white">
      <TopPanel />
      <div className="flex min-h-screen bg-white">
        <LeftPanel 
          activeItem={activeMenuItem} 
          onItemClick={handleTabNavigation}
          disabled={!navigationEnabled}
        />
        <div className="flex-1">
          <div className="max-w-4xl mx-auto">
            <div className="bg-white rounded-lg shadow-lg p-8 my-8" style={{ backgroundColor: '#F9FAFB' }}>
              <div className="text-left mb-8">
                <p className="text-2xl font-semibold" style={{ color: '#33297A' }}>Customer Loan Application</p>
              </div>

              {state.matches("starting") && (
                <div className="bg-white rounded-lg shadow-lg p-8 text-center">
                  <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto mb-4"></div>
                  <p className="text-gray-600">Loading...</p>
                </div>
              )}
              {state.matches("polling") && (
                <div className="bg-white rounded-lg shadow-lg p-8 text-center">
                  <div className="animate-pulse h-4 bg-gray-200 rounded mb-4"></div>
                  <p className="text-gray-600">Waiting for next UI task...</p>
                </div>
              )}
              {state.matches("waitForPoll") && (
   <div className="bg-gray-50 min-h-screen flex flex-col items-center pt-8">
  <div className="w-full max-w-4xl px-6">
    <div className="bg-white rounded-lg shadow p-10 text-center">
      <div className="flex justify-center mb-4">
        <div >
          <img
            src="/success.png" 
            alt="Success Icon"
            className="h-8 w-8"
          />
        </div>
      </div>

      <h3 className="text-xl font-semibold text-gray-800 mb-2">
        Thank you for your Application!
      </h3>
      <p className="text-gray-600 mb-1">
        We have received your loan application and it is now being processed.
      </p>
      <p className="text-gray-600">
        We will get back to you soon with an update on your application status.
      </p>
    </div>
  </div>
</div>

              )}
              {state.matches("rendering") && (
                <>
                  <FormRenderer
                    onUpdate={handleUpdate}
                    onSubmit={handleSubmit}
                    formId={currentTask?.inputData?.form_id}
                  />
                  {/* {currentTask?.inputData?.ui_component === "PersonalInfoForm" && (
                    <PersonalInfoForm
                      onUpdate={handleUpdate}
                      onSubmit={handleSubmit}
                      formData={formData}
                    />
                  )}
                  {currentTask?.inputData?.ui_component === "FinancialInfoForm" && (
                    <FinancialInfoForm
                      onUpdate={handleUpdate}
                      onSubmit={handleSubmit}
                    />
                  )}
                  {currentTask?.inputData?.ui_component === "EmploymentInfoForm" && (
                    <EmploymentInfoForm
                      onUpdate={handleUpdate}
                      onSubmit={handleSubmit}
                    />
                  )}
                  {currentTask?.inputData?.ui_component === "AdditionalInfoForm" && (
                    <AdditionalInfoForm
                      onUpdate={handleUpdate}
                      onSubmit={handleSubmit}
                    />
                  )}
                  {currentTask?.inputData?.ui_component === "ReviewSubmitScreen" && (
                    <ReviewComponent formData={formData} onSubmit={handleSubmit} />
                  )} */}
                </>
              )}

              {state.matches("validating") && (
                <div className="bg-white rounded-lg shadow-lg p-8 text-center">
                  <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto mb-4"></div>
                  <p className="text-gray-600">Validating...</p>
                </div>
              )}
              {state.matches("submitting") && (
                <div className="bg-white rounded-lg shadow-lg p-8 text-center">
                  <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto mb-4"></div>
                  <p className="text-gray-600">Submitting task...</p>
                </div>
              )}
              {state.matches("completed") && (
   <div className="bg-gray-50 min-h-screen flex flex-col items-center pt-8">
  <div className="w-full max-w-4xl px-6">
    <div className="bg-white rounded-lg shadow p-10 text-center">
      <div className="flex justify-center mb-4">
        <div >
          <img
            src="/success.png" 
            alt="Success Icon"
            className="h-8 w-8"
          />
        </div>
      </div>

      <h3 className="text-xl font-semibold text-gray-800 mb-2">
        Thank you for your Application!
      </h3>
      <p className="text-gray-600 mb-1">
        We have received your loan application and it is now being processed.
      </p>
      <p className="text-gray-600">
        We will get back to you soon with an update on your application status.
      </p>
    </div>
  </div>
</div>
              )}

              {state.matches("error") && (
                <div className="bg-white rounded-lg shadow-lg p-6">
                  <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                    <div className="flex items-center mb-3">
                      <div className="text-red-500 text-xl mr-2">⚠️</div>
                      <h3 className="text-lg font-semibold text-red-800">Error</h3>
                    </div>
                    <p className="text-red-700 mb-4">{String(error)}</p>
                    <button
                      onClick={() => send({ type: "RETRY" })}
                      className="bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors"
                    >
                      Retry
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default LoanApplication;
