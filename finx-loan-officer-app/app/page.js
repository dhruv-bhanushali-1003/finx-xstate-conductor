"use client"

// src/App.js
import React from "react";
import { useState } from "react";
import axios from "axios";
import { setup, assign, fromPromise } from "xstate";
import { useMachine } from "@xstate/react";
import { useForm } from "react-hook-form";

// -------------------- Conductor Service --------------------
const ConductorService = {
  async startWorkflow(workflowName = "Fincuro Bank loan-application-process") {
    try {
      const res = await axios.post(`https://base-api.fincuro.in/gateway/ui-workflow/api/workflow`, { name: workflowName });
      return { workflowId: res.data };
    } catch (err) {
      console.error("startWorkflow error:", err);
      throw err;
    }
  },

  async getWorkflowStatus(workflowId) {
    try {
      const res = await axios.get(`https://base-api.fincuro.in/gateway/ui-workflow/api/workflow/${workflowId}`);
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
        `https://base-api.fincuro.in/gateway/ui-workflow/api/tasks/poll/${taskType}?workerid=${workerId}`
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
      const res = await axios.post(`https://base-api.fincuro.in/gateway/ui-workflow/api/tasks`, {
        taskId,
        workflowInstanceId,
        status: "COMPLETED",
        outputData,
      });
      return res.data;
    } catch (err) {
      console.error("completeTask error:", err);
      throw err;
    }
  },

  async searchWorkflows(workflowType) {
    try {
      const res = await axios.get(
        `https://base-api.fincuro.in/gateway/ui-workflow/api/workflow/search?start=0&size=15&sort=startTime%3ADESC&freeText=%2A&workflowType=${encodeURIComponent(workflowType)}`
      );
      return res.data.results || [];
    } catch (err) {
      console.error("searchWorkflows error:", err);
      return [];
    }
  },

  async getAllPendingTasks() {
    try {
      const workflows = await this.searchWorkflows("Finx Bank loan-application-process");
      const pendingTasks = [];

      for (const workflow of workflows) {
        if (workflow.status === "RUNNING") {
          const workflowDetails = await this.getWorkflowStatus(workflow.workflowId);
          const uiTasks = workflowDetails.tasks.filter(
            (t) =>
              t.status === "SCHEDULED" &&
              (t.inputData?.ui_component === "BankReviewInfoScreen" ||
                t.inputData?.ui_component === "BankApprovalScreen")
          );
          
          uiTasks.forEach(task => {
            pendingTasks.push({
              workflowId: workflow.workflowId,
              taskId: task.taskId,
              taskType: task.taskDefName,
              uiComponent: task.inputData?.ui_component,
              customerData: task.inputData?.data || task.inputData?.additionalData || task.inputData?.initialData || {},
              createdTime: workflow.createTime,
              status: task.status
            });
          });
        }
      }
      
      return pendingTasks.sort((a, b) => new Date(a.createdTime) - new Date(b.createdTime));
    } catch (err) {
      console.error("getAllPendingTasks error:", err);
      return [];
    }
  },
};

// -------------------- XState Machine Definition --------------------
export const loanMachine = setup({
  actors: {
    loadTaskQueue: fromPromise(async () => {
      return await ConductorService.getAllPendingTasks();
    }),

    pollNextUiTask: fromPromise(async () => {
      // Search for loan workflows
      const workflows = await ConductorService.searchWorkflows(
        "Finx Bank loan-application-process"
      );

      for (const workflow of workflows) {
        if (workflow.status === "RUNNING") {
          const workflowDetails = await ConductorService.getWorkflowStatus(
            workflow.workflowId
          );
          const uiTask = workflowDetails.tasks.find(
            (t) =>
              t.status === "SCHEDULED" &&
              (t.inputData?.ui_component === "BankReviewInfoScreen" ||
                t.inputData?.ui_component === "BankApprovalScreen")
          );

          if (uiTask) {
            const polled = await ConductorService.pollForTask(
              uiTask.taskDefName
            );
            if (polled) return polled;
          }
        }
      }

      return { status: "WAITING", task: null };
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
        input.currentTask.workflowInstanceId,
        input.currentTask.taskId,
        {
          formData: input.formData,
        }
      );
    }),
  },
}).createMachine({
  id: "loanApp",
  initial: "loadingQueue",
  context: {
    workflowId: null,
    currentTask: null,
    formData: {},
    error: null,
    taskQueue: [],
  },
  states: {
    loadingQueue: {
      invoke: {
        src: "loadTaskQueue",
        onDone: {
          target: "queueView",
          actions: assign({
            taskQueue: ({ event }) => event.output,
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

    queueView: {
      on: {
        PROCESS_NEXT: "polling",
        REFRESH_QUEUE: "loadingQueue",
      },
    },

    polling: {
      invoke: {
        src: "pollNextUiTask",
        onDone: [
          {
            guard: ({ event }) => {
              console.log("Polled event:", event);
              return (
                event.output.task !== null && event.output.status !== "WAITING"
              );
            },
            target: "rendering",
            actions: assign({
              currentTask: ({ event }) => event.output,
              workflowId: ({ event }) => event.output.workflowInstanceId,
            }),
          },
          {
            target: "waitForPoll",
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
        5000: "polling",
      },
    },

    rendering: {
      on: {
        FORM_UPDATE: {
          actions: assign({
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
        onDone: "taskCompleted",
        onError: {
          target: "error",
          actions: assign({
            error: ({ event }) => event.error,
          }),
        },
      },
    },

    taskCompleted: {
      after: {
        3000: "loadingQueue",
      },
    },

    error: {
      on: {
        RETRY: "polling",
      },
    },
  },
});

// -------------------- Components --------------------

function TaskQueueView({ taskQueue, onProcessNext, onRefresh }) {
  return (
<div className="space-y-3 w-full">
  {/* Header section */}
   <div className="flex justify-between items-center">
     <h2 className="text-2xl font-semibold" style={{ fontWeight: 600, fontSize: '24px', color: '#33297A' }}>New Loan Application</h2>
    <button
      onClick={onRefresh}
      className="bg-gray-100 hover:bg-gray-200 px-3 py-1 rounded-md border border-gray-300 transition"
      style={{ fontWeight: 500, fontSize: '16px', color: '#858484' }}
    >
      Refresh
    </button>
  </div>

  {taskQueue.length === 0 ? (
   <div className="bg-white rounded-md shadow-sm border border-gray-200 p-6 text-center">
     <div className="flex justify-center mb-2">
       <img 
         src="/Clipboard.png" 
         alt="Clipboard" 
         className="w-8 h-8 opacity-50"
         onError={(e) => {
           e.target.style.display = 'none';
         }}
       />
     </div>
     <p style={{ fontWeight: 600, fontSize: '22px', color: '#858484' }}>No pending tasks</p>
   </div>
      ) : (
        <>

{/* Review Application Card */}
<div className="bg-white rounded-xl shadow-lg p-6 border border-gray-100">
  {/* Pending count */}
  <div className="mb-4">
    <p className="text-sm text-gray-600">
      {taskQueue.length} task{taskQueue.length !== 1 ? 's' : ''} pending
    </p>
  </div>

<div className="space-y-4 mb-6">
  {taskQueue.map((task, index) => (
     <div
       key={task.taskId}
       className="border border-gray-200 rounded-lg p-4 bg-white shadow-md hover:shadow-lg transition-shadow flex items-start justify-between"
     >
      {/* Left side (radio + details) */}
      <div className="flex items-start space-x-3">
        <input
          type="radio"
          name="selectedTask"
          value={task.taskId}
          onChange={() => setSelectedTask(task.taskId)}
          className="mt-1 h-4 w-4 text-[#33297A] focus:ring-[#33297A]"
        />

         <div>
           <h3 className="font-medium text-gray-900 mb-1">
             <span style={{ backgroundColor: index === 0 ? '#DBEAFE' : 'transparent', padding: '2px 6px', borderRadius: '4px' }}>
               #{index + 1}
             </span> Review Application
           </h3>

          <div className="text-sm text-gray-600 space-y-1">
            <p>
              <strong>Customer:</strong>{' '}
              {`${task.customerData.firstName} ${task.customerData.lastName}`}
            </p>
            <p>
              <strong>Email:</strong> {task.customerData.email}
            </p>
            <p>
              <strong>Phone:</strong> {task.customerData.phone}
            </p>
            <p>
              <strong>Loan Amount:</strong> {task.customerData.loanAmount}
            </p>
          </div>
        </div>
      </div>

      {/* Right side (status badge) */}
      <div>
        <span className="px-3 py-1 text-xs font-medium rounded bg-yellow-100 text-yellow-800">
          {task.status}
        </span>
      </div>
    </div>
  ))}
</div>


{/* Process Button */}
<div className="flex justify-center">
   <button
     onClick={onProcessNext}
     className="w-2/5 bg-purple-600 hover:bg-purple-700 text-white font-semibold py-3 px-6 rounded-lg transition-colors shadow-md"
     style={{ backgroundColor: '#33297A' }}
   >
     Process Next Task
   </button>
</div>
</div>




        </>
      )}
    </div>
  );
}

function BankReviewInfoScreen({ currentTask, onSubmit }) {
  const applicationData = currentTask?.inputData || {};

  const handleConfirm = () => onSubmit({ needsMoreInfo: false });
  const handleRequestMoreInfo = () => onSubmit({ needsMoreInfo: true });

  return (
  <div className="bg-white rounded-xl shadow p-6 border border-gray-100">
   <h2 className="text-lg font-semibold mb-4" style={{ color: '#33297A' }}>
     Bank Review - Application Information
   </h2>

   <div className="bg-white border border-gray-200 rounded-lg p-4 mb-6">
     <h3 className="text-sm font-medium text-gray-800 mb-3">
       Customer Application Details
     </h3>
     <pre className="text-sm text-gray-700 font-mono whitespace-pre-wrap">
       {JSON.stringify(applicationData.data, null, 2)}
     </pre>
   </div>

   <div className="flex gap-3">
     <button
       onClick={handleConfirm}
       className="flex-1 inline-flex items-center justify-center rounded-lg border bg-white font-medium py-2.5 px-4 transition-colors"
       style={{ borderColor: '#33297A', color: '#33297A' }}
       onMouseEnter={(e) => e.target.style.backgroundColor = '#f3f4f6'}
       onMouseLeave={(e) => e.target.style.backgroundColor = 'white'}
     >
       Confirm Information
     </button>
     <button
       onClick={handleRequestMoreInfo}
       className="flex-1 inline-flex items-center justify-center rounded-lg text-white font-medium py-2.5 px-4 transition-colors"
       style={{ backgroundColor: '#33297A' }}
       onMouseEnter={(e) => e.target.style.backgroundColor = '#2a1f5c'}
       onMouseLeave={(e) => e.target.style.backgroundColor = '#33297A'}
     >
       Request Additional Information
     </button>
   </div>
 </div>

  );
}

function BankApprovalScreen({ currentTask, onSubmit }) {
  const applicationData = currentTask?.inputData?.additionalData
    ? currentTask.inputData.additionalData
    : currentTask?.inputData.initialData;
  const handleApprove = () => onSubmit({ approvalStatus: true });
  const handleReject = () => onSubmit({ approvalStatus: false });

  return (
  <div className="bg-white rounded-xl shadow p-6 border border-gray-100">
  <h2 className="text-lg font-semibold mb-4" style={{ color: '#33297A' }}>
    Bank Review - Loan Approval Decision
  </h2>

  <div className="bg-white border border-gray-200 rounded-lg p-4 mb-6">
    <h3 className="text-sm font-medium text-gray-800 mb-3">
      Customer Application Details
    </h3>
    <pre className="text-sm text-gray-700 font-mono whitespace-pre-wrap">
      {JSON.stringify(applicationData, null, 2)}
    </pre>
  </div>

  <div className="flex gap-3">
    <button
      onClick={handleReject}
      className="flex-1 inline-flex items-center justify-center rounded-lg border font-medium py-2.5 px-4 transition-colors"
      style={{
        borderColor: '#33297A',
        color: '#33297A',
        backgroundColor: '#fff',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#f3f2fb')}
      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = '#fff')}
    >
      Reject Loan
    </button>
    <button
      onClick={handleApprove}
      className="flex-1 inline-flex items-center justify-center rounded-lg text-white font-medium py-2.5 px-4 transition-colors"
      style={{
        backgroundColor: '#33297A',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#2a2268')}
      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = '#33297A')}
    >
      Approve Loan
    </button>
  </div>
</div>

  );
}

// -------------------- Layout Components --------------------

function TopPanel() {
  return (
    <div className="text-white px-6 py-4 flex items-center justify-between" style={{ backgroundColor: '#33297A' }}>
      <div className="flex items-center space-x-4">
        <div className="flex items-center space-x-2">
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
      </div>
       
      <div className="flex items-center space-x-4">
        <div className="w-10 h-10 flex items-center justify-center cursor-pointer hover:opacity-80">
          <img 
            src="/search.png" 
            alt="Search" 
            className="w-6 h-6 brightness-150"
            onError={(e) => {
              e.target.style.display = 'none';
            }}
          />
        </div>
        <div className="w-10 h-10 flex items-center justify-center cursor-pointer hover:opacity-80">
          <img 
            src="/notification.png" 
            alt="Notifications" 
            className="w-6 h-6 brightness-150"
            onError={(e) => {
              e.target.style.display = 'none';
            }}
          />
        </div>
        <div className="w-10 h-10 flex items-center justify-center cursor-pointer hover:opacity-80">
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
  );
}
function LeftSidebar({ currentTask, taskQueue, currentState }) {
  const tabs = [
    { id: 'new-loan', label: 'New Loan Applications' },
    { id: 'review', label: 'Review Application' },
    { id: 'choice', label: 'Make a Choice' },
  ];

  // Determine active tab based on current task and state
  const getActiveTab = () => {
    // Only highlight specific menus when actively processing those tasks
    if (currentState === 'rendering' && currentTask?.inputData?.ui_component === 'BankReviewInfoScreen') {
      return 'review';
    } else if (currentState === 'rendering' && currentTask?.inputData?.ui_component === 'BankApprovalScreen') {
      return 'choice';
    } else if (currentState === 'queueView') {
      return 'new-loan'; // Always highlight New Loan Applications when in queue view
    } else if (currentState === 'taskCompleted') {
      return 'new-loan'; // Highlight New Loan Applications after task completion
    }
    return 'new-loan'; // Default to New Loan Applications
  };

  const currentActiveTab = getActiveTab();

  return (
    <div className="w-64 rounded-xl shadow border border-gray-100 p-4 my-8" style={{ backgroundColor: '#F9FAFB' }}>
      <nav className="space-y-2 pt-4">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`flex items-center w-full text-left px-3 py-2 text-sm font-medium transition-all rounded-md ${
              currentActiveTab === tab.id
                ? 'text-[#33297A] font-semibold'
                : 'text-gray-400'
            }`}
          >
            {/* Left border indicator */}
            <div
              className={`w-1 h-6 mr-3 rounded-full ${
                currentActiveTab === tab.id ? 'bg-[#33297A]' : 'bg-gray-200'
              }`}
            ></div>
            <span>{tab.label}</span>
          </div>
        ))}
      </nav>
    </div>
  );
}


// -------------------- Main App --------------------
function LoanApplication() {
  const [state, send] = useMachine(loanMachine);
  const [selectedTask, setSelectedTask] = useState(null);
  const { currentTask, formData, error, taskQueue } = state.context;
  // No need to start workflow - connecting to existing one

  const handleUpdate = (data) => send({ type: "FORM_UPDATE", data });
  const handleSubmit = (data) => {
    console.log("Submitting data:", data);
    send({ type: "FORM_UPDATE", data });
    send({ type: "FORM_SUBMIT" });
  };
  
  const handleProcessNext = () => send({ type: "PROCESS_NEXT" });
  const handleRefreshQueue = () => send({ type: "REFRESH_QUEUE" });

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <TopPanel />
      
      <div className="flex flex-1">
        <LeftSidebar currentTask={currentTask} taskQueue={taskQueue} currentState={state.value} />
        
        <div className="flex-1">
          <div className="max-w-4xl mx-auto">
            <div className="bg-white rounded-lg shadow-lg p-8 my-8" style={{ backgroundColor: '#F9FAFB' }}>


          {state.matches("loadingQueue") && (
            <div className="bg-white rounded-lg shadow-md p-8 text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto mb-4"></div>
              <p className="text-gray-600">Loading loan applications...</p>
            </div>
          )}
          
          {state.matches("queueView") && (
            <TaskQueueView
              taskQueue={taskQueue}
              onProcessNext={handleProcessNext}
              onRefresh={handleRefreshQueue}
              selectedTask={selectedTask}
              onTaskSelect={setSelectedTask}
            />
          )}

          {state.matches("polling") && (
            <div className="bg-white rounded-lg shadow-md p-8 text-center">
              <div className="animate-pulse h-4 bg-gray-200 rounded mb-4"></div>
              <p className="text-gray-600">
                Waiting for customer applications to review...
              </p>
            </div>
          )}
          {state.matches("waitForPoll") && (
            <div className="bg-white rounded-lg shadow-md p-8 text-center">
              <div className="animate-pulse h-4 bg-gray-200 rounded mb-4"></div>
              <p className="text-gray-600">
                Waiting for customer applications to review...
              </p>
            </div>
          )}
          {state.matches("rendering") && (
            <>
              {currentTask?.inputData?.ui_component ===
                "BankReviewInfoScreen" && (
                <BankReviewInfoScreen
                  currentTask={currentTask}
                  onSubmit={handleSubmit}
                />
              )}
              {currentTask?.inputData?.ui_component === "BankApprovalScreen" && (
                <BankApprovalScreen
                  currentTask={currentTask}
                  onSubmit={handleSubmit}
                />
              )}
            </>
          )}

          {state.matches("validating") && (
            <div className="bg-white rounded-lg shadow-md p-8 text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto mb-4"></div>
              <p className="text-gray-600">Validating...</p>
            </div>
          )}
          {state.matches("submitting") && (
            <div className="bg-white rounded-lg shadow-md p-8 text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto mb-4"></div>
              <p className="text-gray-600">Submitting task...</p>
            </div>
          )}
          {state.matches("taskCompleted") && (
       <div className="p-6 border border-gray-200 rounded-lg text-center bg-white">
  <div className="text-4xl mb-4 text-green-600">✅</div>
  <h2 className="text-2xl font-bold mb-2" style={{ color: '#33297A' }}>
    Task Completed Successfully!
  </h2>
  <p className="mb-4" style={{ color: '#33297A' }}>
    Your review has been submitted.
  </p>
</div>

          )}

          {state.matches("error") && (
            <div className="bg-white rounded-lg shadow-md p-6">
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
